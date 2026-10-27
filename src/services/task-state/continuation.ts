import * as path from "node:path"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Task } from "../../core/task/Task"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { directory, locked, readText, regularFile } from "../memory/files"
import { assertNoSecrets } from "../memory/records"
import { taskStateDigestSchema, taskStateIdSchema, type TaskStatePolicy } from "../../../packages/types/src/task-state"
import { taskStateStore, assertTaskStateAccess, hasTaskState } from "./taskState"
import { stateHash, taskHistoryAnchors } from "./history"
import { evaluateContinuation } from "./policy"

const counter = z.number().int().nonnegative().safe()
const runtimeSchema = z
	.object({
		version: z.literal(1),
		taskId: taskStateIdSchema,
		workspaceId: taskStateDigestSchema,
		policyDigest: taskStateDigestSchema,
		steps: counter,
		tokens: counter,
		elapsedMs: counter,
		noProgressSteps: counter,
		lastProgress: z.string(),
		lastTokens: counter,
		startedAt: counter.nullable(),
		historyAnchor: taskStateDigestSchema,
		status: z.enum(["completed", "blocked", "incomplete", "awaiting-approval"]),
		reason: z.string().max(200),
		checks: z
			.array(
				z
					.object({
						id: taskStateIdSchema,
						result: z.enum(["passed", "failed"]),
						note: z.string().min(1).max(8000),
						provenance: z.literal("user_attested"),
						historyAnchor: taskStateDigestSchema,
						progress: taskStateDigestSchema,
					})
					.strict(),
			)
			.max(100),
	})
	.strict()
type Runtime = z.infer<typeof runtimeSchema>
const armed = new WeakSet<Task>()
const managed = new WeakSet<Task>()
const stopped = new WeakMap<Task, string>()
const configurations = new WeakMap<Task, string>()
const totalTokens = (task: Task) => {
	const usage = task.getTokenUsage()
	return Math.ceil(
		(usage.totalTokensIn ?? 0) +
			(usage.totalTokensOut ?? 0) +
			(usage.totalCacheReads ?? 0) +
			(usage.totalCacheWrites ?? 0),
	)
}
const policyDigest = (policy: TaskStatePolicy) => stateHash(JSON.stringify(policy))
const progressDigest = (data: unknown) => stateHash(JSON.stringify(data))

/** Synchronous revocation closes the loop even when cancellation prevents further persistence. */
export function stopTaskContinuation(task: Task, reason = "stopped") {
	armed.delete(task)
	stopped.set(task, reason)
}

async function transaction<T>(
	task: Task,
	operation: (runtime: Runtime, policy: TaskStatePolicy, progress: string, anchors: string[]) => T,
	reset = false,
): Promise<T> {
	const store = await taskStateStore(task)
	const file = path.join(store.taskDir, "task-state-runtime.json")
	const epoch = task.taskStateEpoch
	return locked(`${file}.transaction`, async (assertLock) => {
		const history = taskHistoryAnchors(task.apiConversationHistory)
		const state = await store.read(history.anchors)
		if (!state.snapshot) throw new Error("Task state must be initialized with compatible history")
		const text = await readText(file, 1024 * 1024)
		let runtime = text ? runtimeSchema.parse(JSON.parse(text)) : undefined
		if (runtime && (runtime.taskId !== task.taskId || runtime.workspaceId !== store.workspaceId))
			throw new Error("Continuation identity mismatch")
		if (!runtime || reset)
			runtime = {
				version: 1,
				taskId: task.taskId,
				workspaceId: store.workspaceId,
				policyDigest: policyDigest(state.policy),
				steps: 0,
				tokens: 0,
				elapsedMs: 0,
				noProgressSteps: 0,
				lastProgress: "",
				lastTokens: totalTokens(task),
				startedAt: null,
				historyAnchor: history.anchor,
				status: "incomplete",
				reason: "not-started",
				checks: [],
			}
		if (runtime.policyDigest !== policyDigest(state.policy)) {
			stopTaskContinuation(task, "policy-changed")
			runtime.checks = []
		}
		if (!history.anchors.includes(runtime.historyAnchor)) {
			stopTaskContinuation(task, "history-changed")
			runtime.checks = []
		}
		const now = Date.now()
		if (runtime.startedAt !== null) runtime.elapsedMs += Math.max(0, now - runtime.startedAt)
		runtime.startedAt = armed.has(task) ? now : null
		const usage = totalTokens(task)
		runtime.tokens += Math.max(0, usage - runtime.lastTokens)
		runtime.lastTokens = usage
		const progress = progressDigest({ ...state.snapshot.data, evidenceRefs: [] })
		const acceptance = progressDigest({
			progress,
			tools: task.apiConversationHistory.flatMap((message) =>
				Array.isArray(message.content)
					? message.content.filter(
							(block) =>
								block.type === "tool_use" && !["attempt_completion", "task_state"].includes(block.name),
						)
					: [],
			),
		})
		runtime.checks = runtime.checks.filter(
			(check) => check.progress === acceptance && history.anchors.includes(check.historyAnchor),
		)
		const result = operation(runtime, state.policy, progress, history.anchors)
		// Attestation is the only operation that appends checks. Bind new entries to tool history too.
		for (const check of runtime.checks) if (check.progress === progress) check.progress = acceptance
		runtime.historyAnchor = history.anchor
		if (stopped.has(task)) {
			runtime.status =
				stopped.get(task) === "awaiting-approval"
					? "awaiting-approval"
					: stopped.get(task) === "blocked"
						? "blocked"
						: "incomplete"
			runtime.reason = stopped.get(task)!
		}
		const parsed = runtimeSchema.parse(runtime)
		assertNoSecrets(JSON.stringify(parsed))
		assertTaskStateAccess(task, store)
		if (task.taskStateEpoch !== epoch || taskHistoryAnchors(task.apiConversationHistory).anchor !== history.anchor)
			throw new Error("Continuation operation became stale")
		assertLock()
		await regularFile(file)
		const stageDir = `${file}.transaction.lock`
		await directory(stageDir)
		await fs.chmod(stageDir, 0o700)
		const stage = path.join(stageDir, `${randomUUID()}.json`)
		try {
			await safeWriteJson(stage, parsed)
			await fs.chmod(stage, 0o600)
			assertLock()
			assertTaskStateAccess(task, store)
			if (
				task.taskStateEpoch !== epoch ||
				taskHistoryAnchors(task.apiConversationHistory).anchor !== history.anchor
			)
				throw new Error("Continuation operation became stale")
			await regularFile(file)
			await fs.rename(stage, file)
		} finally {
			await fs.unlink(stage).catch(() => {})
		}
		return result
	})
}

export async function continuationView(task: Task) {
	const store = await taskStateStore(task)
	const text = await readText(path.join(store.taskDir, "task-state-runtime.json"), 1024 * 1024)
	if (!text) return undefined
	const runtime = runtimeSchema.parse(JSON.parse(text))
	if (runtime.taskId !== task.taskId || runtime.workspaceId !== store.workspaceId)
		throw new Error("Continuation identity mismatch")
	return {
		...runtime,
		armed: armed.has(task),
		reason: stopped.get(task) ?? (armed.has(task) ? runtime.reason : "native-resume-required"),
	}
}

export async function resetTaskContinuation(task: Task) {
	stopTaskContinuation(task, "configured")
	await transaction(task, () => {}, true)
	managed.delete(task)
}

/** Native-only. Resumes counters, never silently resets a spent budget. Does not dispatch a model or tool. */
export async function startTaskContinuation(task: Task) {
	await transaction(task, (runtime, policy) => {
		if (!policy.enabled || !policy.recallEnabled || !policy.checks.length)
			throw new Error("Enable continuation and define user-attested acceptance checks first")
		if (runtime.policyDigest !== policyDigest(policy))
			throw new Error("Reconfigure continuation after policy changes")
		const decision = evaluateContinuation({
			...runtime,
			policy,
			awaitingApproval: false,
			blocked: false,
			checks: [],
		})
		if (!decision.shouldContinue) throw new Error(`Continuation budget unavailable: ${decision.reason}`)
		runtime.startedAt = Date.now()
		runtime.reason = "armed"
		runtime.status = "incomplete"
	})
	stopped.delete(task)
	armed.add(task)
	managed.add(task)
	configurations.set(task, stateHash(JSON.stringify(task.apiConfiguration)))
}

export async function persistContinuationStop(task: Task) {
	if (!(await hasTaskState(task))) return
	await transaction(task, () => {})
}

/** Check before each admitted tool. This never grants a tool permission. */
export async function assertContinuationToolAllowed(task: Task): Promise<void> {
	if (!managed.has(task)) return
	if (stopped.has(task)) throw new Error(`Autonomous continuation stopped: ${stopped.get(task)}`)
	const decision = await transaction(task, (runtime, policy) => {
		if (configurations.get(task) !== stateHash(JSON.stringify(task.apiConfiguration)))
			stopTaskContinuation(task, "model-changed")
		return evaluateContinuation({
			...runtime,
			steps: Math.max(0, runtime.steps - 1),
			policy,
			awaitingApproval: false,
			blocked: false,
			checks: [],
		})
	})
	if (!armed.has(task) || !decision.shouldContinue) {
		stopTaskContinuation(task, decision.reason)
		throw new Error(`Autonomous continuation stopped: ${decision.reason}`)
	}
}

export async function attestTaskCheck(task: Task, check: { id: string; result: "passed" | "failed"; note: string }) {
	await transaction(task, (runtime, policy, progress, anchors) => {
		if (!policy.checks.some((candidate) => candidate.id === check.id))
			throw new Error("Unknown approved acceptance check")
		runtime.checks = runtime.checks.filter((previous) => previous.id !== check.id)
		runtime.checks.push({ ...check, provenance: "user_attested", progress, historyAnchor: anchors.at(-1)! })
	})
}

/** Reserve a step before each ordinary model turn. Reopened tasks are never armed. */
export async function reserveContinuationTurn(task: Task) {
	if (managed.has(task) && stopped.has(task))
		throw new Error(`Autonomous continuation stopped: ${stopped.get(task)}. Native resume is required.`)
	if (!armed.has(task)) return
	const allowed = await transaction(task, (runtime, policy, progress) => {
		if (configurations.get(task) !== stateHash(JSON.stringify(task.apiConfiguration)))
			stopTaskContinuation(task, "model-changed")
		runtime.noProgressSteps = runtime.lastProgress === progress ? runtime.noProgressSteps + 1 : 0
		const decision = evaluateContinuation({
			...runtime,
			policy,
			awaitingApproval: false,
			blocked: false,
			checks: [],
		})
		if (!armed.has(task) || !decision.shouldContinue) {
			stopTaskContinuation(task, decision.reason)
			return false
		}
		runtime.lastProgress = progress
		runtime.steps++
		return true
	})
	if (!allowed) throw new Error("Autonomous continuation stopped at its approved limit; native review is required")
}

/** Completion hook: user attestations stay labeled; no model claim can pass a check. */
export async function taskCompletionGate(
	task: Task,
): Promise<{ continue: boolean; completed?: boolean; message: string } | undefined> {
	if (!(await hasTaskState(task))) return undefined
	const store = await taskStateStore(task)
	const state = await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)
	if (!state.snapshot || !state.policy.enabled || !state.policy.recallEnabled) return undefined
	return transaction(task, (runtime, policy) => {
		const accepted =
			policy.checks.length > 0 &&
			policy.checks.every((check) =>
				runtime.checks.some((result) => result.id === check.id && result.result === "passed"),
			)
		const decision = evaluateContinuation({
			...runtime,
			policy,
			awaitingApproval: false,
			blocked: state.snapshot!.data.blockers.length > 0,
			checks: [],
		})
		if (accepted && !state.snapshot!.data.blockers.length) {
			armed.delete(task)
			stopped.delete(task)
			runtime.status = "completed"
			runtime.reason = "user-attested-acceptance"
			return {
				continue: false,
				completed: true,
				message: "Acceptance checks passed by explicit user attestation, not automated verification.",
			}
		}
		if (armed.has(task) && decision.shouldContinue)
			return {
				continue: true,
				message:
					"Approved acceptance checks remain pending. Continue the next bounded step under existing permissions. Update task state only at a meaningful milestone. If blocked or user review is needed, ask and stop; do not assert that model claims pass checks.",
			}
		const reason = stopped.get(task) ?? (armed.has(task) ? decision.reason : "native-resume-required")
		stopTaskContinuation(task, reason)
		runtime.status = reason === "awaiting-approval" ? "awaiting-approval" : decision.status
		runtime.reason = reason
		return {
			continue: false,
			message: `Task status: ${runtime.status}. Acceptance remains unconfirmed (${runtime.reason}). Native review/resume is required; this is not verified success.`,
		}
	})
}
