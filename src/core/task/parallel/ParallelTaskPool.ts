/**
 * Parallel task pool (ADR-2026-11-22-parallel-subtasks, rules 2 to 5 and 7). One per provider.
 *
 * - Children are ordinary `Task` instances that are NOT added to `clineStack`. `getCurrentTask()` and
 *   every single-stack path keep seeing the parent, which stays on the stack and waits.
 * - Each child runs in its own git worktree (`workspace: isolated`), created with the subtask-workspace
 *   helpers. Children are saved as ordinary history items with `parentTaskId` (C-5).
 * - Children are headless (no webview posts) and non-interactive (Q-SEC-3, see non-interactive.ts).
 * - All children of a batch share one BatchAdmissionRuntime on every provider: concurrency limit and
 *   shared token budget. Children start at the same time; the runtime enforces concurrency.
 * - Each child records its own evaluation stop: completed, user-stopped, budget-denied (or error).
 *
 * B3 (`new_tasks`) calls `startBatch` and then awaits `waitForBatch`. Nothing is merged.
 */

import { execFile } from "child_process"
import { promisify } from "util"

import { v7 as uuidv7 } from "uuid"

import {
	RooCodeEventName,
	type ParallelBatchInfo,
	type ParallelChildStatus,
	type ProviderSettings,
} from "@roo-code/types"

import type { ClineProvider } from "../../webview/ClineProvider"
import { Task } from "../Task"
import { recordShutdownStop, type EvaluationStopReason } from "../evaluation-recording"
import {
	createIsolatedWorkspace,
	planIsolatedWorkspace,
	summarizeIsolatedWorkspace,
	type IsolatedSubtaskWorkspace,
} from "../../tools/subtask-workspace"
import { BatchAdmissionRuntime } from "./BatchAdmissionRuntime"
import { createHeadlessProvider } from "./headless-provider"
import {
	decideNonInteractiveAsk,
	OUTSIDE_WORKTREE_REFUSAL,
	parallelChildToolPolicy,
	type NonInteractiveTaskHooks,
	type RefusedApproval,
} from "./non-interactive"

export const MIN_PARALLEL_CHILDREN = 1
export const MAX_PARALLEL_CHILDREN = 4

const execFileAsync = promisify(execFile)

/**
 * Model-facing preamble of each child's first message (D-1). The parent's brief often names the
 * parent's absolute path; the child must use the matching path in its own worktree instead.
 */
export function parallelChildBrief(workspace: Pick<IsolatedSubtaskWorkspace, "worktreePath" | "branch">): string {
	return `Your workspace is the git worktree ${workspace.worktreePath} on branch ${workspace.branch}. Resolve every relative path against it. Do not read or write files in other checkouts of this repository. Ignore any absolute path to another checkout given below; use the matching path inside your worktree instead.`
}

/** `git status --porcelain` lines of the parent tree, or undefined when git fails. Never throws. */
async function parentTreeStatus(repoRoot: string): Promise<string[] | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
			cwd: repoRoot,
			maxBuffer: 4 * 1024 * 1024,
		})
		return stdout.split("\n").filter((line) => line.trim())
	} catch {
		return undefined
	}
}

export interface ParallelChildSpec {
	mode: string
	message: string
	/** Provider profile for this child. Defaults to the parent's task configuration. */
	apiConfiguration?: ProviderSettings
}

export interface StartBatchOptions {
	parent: Task
	children: ParallelChildSpec[]
	/** 1 to 4. Defaults to the `parallelSubtasksConcurrency` setting, then 2. */
	concurrency?: number
	/** Input plus output tokens for the whole batch. Defaults to `parallelSubtasksTokenBudget`, then 2,000,000. */
	tokenBudget?: number
}

export interface ParallelChildResult {
	taskId: string
	mode: string
	stopReason: EvaluationStopReason
	/** The attempt_completion result, or the child's last text. */
	summary: string
	workspace: IsolatedSubtaskWorkspace
	/** summarizeIsolatedWorkspace(): branch, diff stat and uncommitted files. */
	workspaceSummary: string
	refusedApprovals: RefusedApproval[]
	startedAt: number
	endedAt: number
	error?: string
}

export interface ParallelBatchResult {
	batchId: string
	parentTaskId: string
	concurrency: number
	tokenBudget: number
	usedTokens: number
	budgetExhausted: boolean
	children: ParallelChildResult[]
	/**
	 * Parent tree check: `git status --porcelain` lines that appeared or disappeared in the parent's
	 * repository between batch start and batch end. Empty when unchanged; undefined when git failed.
	 * A file that was already modified at start and changed again is not detected.
	 */
	parentTreeChanges?: string[]
}

interface ChildState {
	taskId: string
	mode: string
	task: Task
	/** Strong reference: Task holds its provider only through a WeakRef. */
	provider: ClineProvider
	workspace: IsolatedSubtaskWorkspace
	refused: RefusedApproval[]
	stopReason?: EvaluationStopReason
	summary?: string
	error?: string
	startedAt: number
	endedAt?: number
	aborting?: Promise<void>
	markStopped: () => void
	stopped: Promise<void>
	done?: Promise<void>
}

interface BatchState {
	id: string
	parent: Task
	runtime: BatchAdmissionRuntime
	children: ChildState[]
	done: Promise<ParallelBatchResult>
	/** Parent repository root and its `git status --porcelain` at batch start (undefined when git failed). */
	repoRoot: string
	parentStatusBefore?: string[]
}

/** Grace period for a stopped child's loop to unwind before the batch result is built. */
const STOP_GRACE_MS = 2_000

/** Finished batches kept for status views (Background activity), newest last. */
const FINISHED_BATCH_LIMIT = 8

/** UI status of a child (rule 6). */
export function parallelChildStatus(child: {
	stopReason?: EvaluationStopReason
	endedAt?: number
}): ParallelChildStatus {
	switch (child.stopReason) {
		case undefined:
			return child.endedAt ? "failed" : "running"
		case "completed":
			return "completed"
		case "user-stopped":
		case "abandoned":
			return "stopped"
		case "budget-denied":
			return "budget-denied"
		default:
			return "failed"
	}
}

function settingNumber(provider: ClineProvider, key: string): number | undefined {
	try {
		const value = (provider.contextProxy?.getValue as ((key: string) => unknown) | undefined)?.call(
			provider.contextProxy,
			key,
		)
		return typeof value === "number" ? value : undefined
	} catch {
		return undefined
	}
}

/** The attempt_completion result, otherwise the last assistant text (never the task message itself). */
export function extractChildSummary(task: Pick<Task, "clineMessages">): string {
	const messages = task.clineMessages ?? []
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.type === "say" && message.say === "completion_result" && message.text) return message.text
	}
	for (let i = messages.length - 1; i > 0; i--) {
		const message = messages[i]
		if (message.type === "say" && message.say === "text" && message.text) return message.text
	}
	return ""
}

export class ParallelTaskPool {
	private readonly batches = new Map<string, BatchState>()
	/** Finished batches whose result was collected, kept for status views and Open. */
	private readonly finished = new Map<string, BatchState>()
	private readonly listeners = new Set<() => void>()
	private disposed = false

	constructor(private readonly provider: ClineProvider) {}

	/** Called on every child state change (start, request, stop). Returns an unsubscribe function. */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emitChange(): void {
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// A status listener never affects the batch.
			}
		}
	}

	/** Status of a running or finished batch for the UI. */
	getBatchInfo(batchId: string): ParallelBatchInfo | undefined {
		const batch = this.batches.get(batchId) ?? this.finished.get(batchId)
		return batch ? this.describe(batch) : undefined
	}

	/** The running batch of a parent, otherwise its most recently finished batch. */
	getBatchInfoForParent(parentTaskId: string | undefined): ParallelBatchInfo | undefined {
		if (!parentTaskId) return undefined
		const find = (map: Map<string, BatchState>) =>
			[...map.values()].reverse().find((batch) => batch.parent.taskId === parentTaskId)
		const batch = find(this.batches) ?? find(this.finished)
		return batch ? this.describe(batch) : undefined
	}

	/** A child task of a running or finished batch (read-only use, e.g. Open). */
	getChildTask(batchId: string, taskId: string): Task | undefined {
		const batch = this.batches.get(batchId) ?? this.finished.get(batchId)
		return batch?.children.find((child) => child.taskId === taskId)?.task
	}

	private describe(batch: BatchState): ParallelBatchInfo {
		return {
			batchId: batch.id,
			parentTaskId: batch.parent.taskId,
			concurrency: batch.runtime.concurrency,
			tokenBudget: batch.runtime.tokenBudget,
			usedTokens: batch.runtime.usedTokens,
			running: batch.children.some((child) => !child.endedAt),
			children: batch.children.map((child) => {
				const messages = child.task.clineMessages ?? []
				let cost = 0
				try {
					cost = child.task.getTokenUsage?.().totalCost ?? 0
				} catch {
					cost = 0
				}
				return {
					taskId: child.taskId,
					mode: child.mode,
					status: parallelChildStatus(child),
					requests: messages.filter((m) => m.type === "say" && m.say === "api_req_started").length,
					cost: Number.isFinite(cost) ? cost : 0,
					branch: child.workspace.branch,
				}
			}),
		}
	}

	/** IDs of batches whose result has not been collected or that are still running. */
	get batchIds(): string[] {
		return [...this.batches.keys()]
	}

	/** Every child task of every batch (for status views). Children are never on the task stack. */
	getChildTasks(batchId?: string): Task[] {
		const batches = batchId ? [this.batches.get(batchId)].filter(Boolean) : [...this.batches.values()]
		return (batches as BatchState[]).flatMap((batch) => batch.children.map((child) => child.task))
	}

	/**
	 * Create one isolated worktree per child, then start every child at once.
	 * Throws, and starts nothing, when the parent workspace cannot host isolated worktrees.
	 */
	async startBatch(options: StartBatchOptions): Promise<string> {
		const { parent, children } = options
		if (this.disposed) throw new Error("The parallel task pool is disposed.")
		if (parent.nonInteractive) throw new Error("A parallel subtask cannot start parallel subtasks.")
		if (children.length < MIN_PARALLEL_CHILDREN || children.length > MAX_PARALLEL_CHILDREN)
			throw new Error(`A parallel batch takes ${MIN_PARALLEL_CHILDREN} to ${MAX_PARALLEL_CHILDREN} children.`)
		for (const spec of children) {
			if (!spec?.mode || !spec?.message) throw new Error("Every parallel child needs a mode and a message.")
		}
		if (parent.abort || parent.abandoned) throw new Error("The parent task is closed.")

		const runtime = new BatchAdmissionRuntime({
			concurrency: options.concurrency ?? settingNumber(this.provider, "parallelSubtasksConcurrency"),
			tokenBudget: options.tokenBudget ?? settingNumber(this.provider, "parallelSubtasksTokenBudget"),
		})

		// Isolation fails with an error and never falls back to the shared workspace (rule 7).
		const plan = await planIsolatedWorkspace(parent.cwd)
		// Taken before the worktrees exist; they are created next to the repository, not inside it.
		const parentStatusBefore = await parentTreeStatus(plan.repoRoot)
		const prepared: Array<{
			spec: ParallelChildSpec
			taskId: string
			workspace: IsolatedSubtaskWorkspace
			cwd: string
		}> = []
		for (const spec of children) {
			const taskId = uuidv7()
			const { workspace, childCwd } = await createIsolatedWorkspace(parent.cwd, taskId, plan)
			prepared.push({ spec, taskId, workspace, cwd: childCwd })
		}

		const batchId = uuidv7()
		const states = prepared.map((item) => this.createChild(parent, runtime, item))
		const onParentAborted = () => void this.stopBatch(batchId).catch(() => {})
		parent.on(RooCodeEventName.TaskAborted, onParentAborted)

		for (const child of states) {
			const changed = () => this.emitChange()
			child.task.on(RooCodeEventName.Message, changed)
			child.task.on(RooCodeEventName.TaskTokenUsageUpdated, changed)
			child.done = this.runChild(child).finally(() => {
				child.task.off(RooCodeEventName.Message, changed)
				child.task.off(RooCodeEventName.TaskTokenUsageUpdated, changed)
				this.emitChange()
			})
		}
		const batch: BatchState = {
			id: batchId,
			parent,
			runtime,
			children: states,
			repoRoot: plan.repoRoot,
			parentStatusBefore,
			done: Promise.all(states.map((child) => child.done)).then(async () => {
				parent.off(RooCodeEventName.TaskAborted, onParentAborted)
				return this.buildResult(batch)
			}),
		}
		this.batches.set(batchId, batch)
		this.emitChange()
		return batchId
	}

	/** Resolves when every child has stopped. */
	async waitForBatch(batchId: string): Promise<ParallelBatchResult> {
		const batch = this.batches.get(batchId)
		if (!batch) throw new Error(`Unknown parallel batch: ${batchId}`)
		try {
			return await batch.done
		} finally {
			if (this.batches.delete(batchId)) {
				this.finished.set(batchId, batch)
				while (this.finished.size > FINISHED_BATCH_LIMIT)
					this.finished.delete(this.finished.keys().next().value!)
				this.emitChange()
			}
		}
	}

	/** Abort every running child. Each records `user-stopped`. Resolves when all have stopped. */
	async stopBatch(batchId: string): Promise<void> {
		const batch = this.batches.get(batchId)
		if (!batch) return
		await Promise.all(batch.children.map((child) => this.stopChildState(child, "user-stopped")))
		await batch.done.catch(() => undefined)
	}

	/**
	 * Abort one running child. It records `user-stopped`; the other children keep running.
	 * Resolves when that child has stopped. Unknown batch or child IDs do nothing.
	 */
	async stopChild(batchId: string, taskId: string): Promise<void> {
		const child = this.batches.get(batchId)?.children.find((entry) => entry.taskId === taskId)
		if (child) await this.stopChildState(child, "user-stopped")
	}

	/** Record shutdown stops for running children (extension deactivation). Best effort. */
	async recordShutdownStops(): Promise<void> {
		await Promise.all(
			[...this.batches.values()].flatMap((batch) =>
				batch.children.filter((child) => !child.endedAt).map((child) => recordShutdownStop(child.task)),
			),
		)
	}

	/** Provider disposal: record shutdown stops, then stop every batch. */
	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		this.listeners.clear()
		await this.recordShutdownStops()
		await Promise.all(
			[...this.batches.values()].map(async (batch) => {
				await Promise.all(batch.children.map((child) => this.stopChildState(child, "abandoned")))
				await batch.done.catch(() => undefined)
			}),
		)
	}

	private createChild(
		parent: Task,
		runtime: BatchAdmissionRuntime,
		item: { spec: ParallelChildSpec; taskId: string; workspace: IsolatedSubtaskWorkspace; cwd: string },
	): ChildState {
		const headless = createHeadlessProvider(this.provider, { mode: item.spec.mode })
		let markStopped = () => {}
		const stopped = new Promise<void>((resolve) => (markStopped = resolve))
		const child = {
			taskId: item.taskId,
			mode: item.spec.mode,
			provider: headless,
			workspace: item.workspace,
			refused: [] as RefusedApproval[],
			startedAt: Date.now(),
			markStopped,
			stopped,
		} as ChildState

		const hooks: NonInteractiveTaskHooks = {
			answerAsk: (type, text) => {
				const decision = decideNonInteractiveAsk(type, text)
				if (decision.refused) child.refused.push(decision.refused)
				if (decision.stop) {
					const reason: EvaluationStopReason =
						decision.stop === "mistake_limit_reached"
							? "mistake-limit"
							: child.task.modelDispatchOutcome?.code === "budget-denied"
								? "budget-denied"
								: "error"
					this.markStop(child, reason)
					// resume_task ends the loop by itself; other terminal prompts would loop or retry.
					if (decision.stop !== "resume_task") setImmediate(() => void this.abortChild(child))
				}
				return { response: decision.response, text: decision.text }
			},
		}

		const apiConfiguration = structuredClone(item.spec.apiConfiguration ?? parent.apiConfiguration)
		child.task = new Task({
			provider: headless,
			apiConfiguration,
			taskId: item.taskId,
			task: `${parallelChildBrief(item.workspace)}\n\n${item.spec.message}`,
			parentTask: parent,
			rootTask: parent.rootTask ?? parent,
			initialTaskContext: { mode: item.spec.mode, apiConfigName: parent.taskApiConfigName },
			subtaskWorkspace: item.workspace,
			workspacePath: item.cwd,
			initialStatus: "active",
			// Checkpoints use a shadow repository per task; the worktree branch already records the work.
			enableCheckpoints: false,
			consecutiveMistakeLimit: apiConfiguration.consecutiveMistakeLimit,
			modelDispatchRuntime: runtime,
			// Refuses delegation tools and every change outside the worktree before any approval (D-1).
			toolInvocationPolicy: parallelChildToolPolicy((refused) => child.refused.push(refused), {
				worktreePath: item.workspace.worktreePath,
				cwd: item.cwd,
			}),
			nonInteractive: hooks,
			startTask: false,
		})

		child.task.on(RooCodeEventName.TaskCompleted, () => {
			child.summary = extractChildSummary(child.task)
			this.markStop(child, "completed")
			void this.abortChild(child)
		})
		return child
	}

	private markStop(child: ChildState, reason: EvaluationStopReason): void {
		if (child.stopReason) return
		child.stopReason = reason
		child.task.recordEvaluationStop(reason)
		this.emitChange()
	}

	private abortChild(child: ChildState): Promise<void> {
		if (!child.aborting) {
			child.summary ??= extractChildSummary(child.task)
			child.aborting = child.task
				.abortTask()
				.catch((error) => {
					child.error ??= error instanceof Error ? error.message : String(error)
				})
				.finally(() => child.markStopped())
		}
		return child.aborting
	}

	private async stopChildState(child: ChildState, reason: EvaluationStopReason): Promise<void> {
		if (child.endedAt) return
		if (reason === "user-stopped") child.task.abortReason = "user_cancelled"
		this.markStop(child, reason)
		await this.abortChild(child)
		await child.done
	}

	private async runChild(child: ChildState): Promise<void> {
		child.startedAt = Date.now()
		const loop = child.task.startAndWait().catch((error) => {
			child.error ??= error instanceof Error ? error.message : String(error)
		})
		// A stopped child counts as stopped once its abort completes, even if its loop is still unwinding.
		await Promise.race([
			loop,
			child.stopped.then(() => Promise.race([loop, new Promise((r) => setTimeout(r, STOP_GRACE_MS))])),
		])
		if (!child.stopReason) {
			const reason: EvaluationStopReason =
				child.task.modelDispatchOutcome?.code === "budget-denied"
					? "budget-denied"
					: child.task.abortReason === "user_cancelled"
						? "user-stopped"
						: "error"
			this.markStop(child, reason)
		}
		await this.abortChild(child)
		child.endedAt = Date.now()
	}

	private async buildResult(batch: BatchState): Promise<ParallelBatchResult> {
		const children = await Promise.all(
			batch.children.map(
				async (child): Promise<ParallelChildResult> => ({
					taskId: child.taskId,
					mode: child.mode,
					stopReason: child.stopReason ?? "error",
					summary: child.summary ?? extractChildSummary(child.task),
					workspace: child.workspace,
					workspaceSummary: await summarizeIsolatedWorkspace(child.workspace),
					refusedApprovals: [...child.refused],
					startedAt: child.startedAt,
					endedAt: child.endedAt ?? Date.now(),
					...(child.error ? { error: child.error } : {}),
				}),
			),
		)
		const before = batch.parentStatusBefore
		const after = before ? await parentTreeStatus(batch.repoRoot) : undefined
		const parentTreeChanges =
			before && after
				? [
						...after.filter((line) => !before.includes(line)),
						...before.filter((line) => !after.includes(line)).map((line) => `(no longer listed) ${line}`),
					]
				: undefined
		return {
			batchId: batch.id,
			parentTaskId: batch.parent.taskId,
			concurrency: batch.runtime.concurrency,
			tokenBudget: batch.runtime.tokenBudget,
			usedTokens: batch.runtime.usedTokens,
			budgetExhausted: batch.runtime.budgetExhausted,
			children,
			parentTreeChanges,
		}
	}
}

function formatRefused(refused: RefusedApproval): string {
	return `- ${refused.type === OUTSIDE_WORKTREE_REFUSAL ? "outside worktree" : refused.type}${refused.tool ? ` ${refused.tool}` : ""}${refused.detail ? `: ${refused.detail}` : ""}`
}

/** One model-facing tool result for the parent (rule 5). Nothing is merged. */
export function formatParallelBatchResult(result: ParallelBatchResult): string {
	const lines = [
		`Parallel subtasks finished: ${result.children.length} children, concurrency ${result.concurrency}, ${result.usedTokens} of ${result.tokenBudget} tokens used${result.budgetExhausted ? " (token budget exhausted)" : ""}.`,
	]
	result.children.forEach((child, index) => {
		lines.push("", `Child ${index + 1} (${child.mode}, task ${child.taskId}): stop reason ${child.stopReason}.`)
		if (child.stopReason === "budget-denied")
			lines.push("This child stopped because the shared token budget of the batch was exhausted.")
		lines.push(`Result: ${child.summary || "(no result text)"}`)
		lines.push(child.workspaceSummary)
		const outside = child.refusedApprovals.filter((r) => r.type === OUTSIDE_WORKTREE_REFUSAL)
		const asks = child.refusedApprovals.filter((r) => r.type !== OUTSIDE_WORKTREE_REFUSAL)
		if (asks.length) {
			lines.push("Refused approvals (the child could not ask the user):")
			for (const refused of asks) lines.push(formatRefused(refused))
		}
		if (outside.length) {
			lines.push("Refused changes outside the child's worktree (not applied):")
			for (const refused of outside) lines.push(formatRefused(refused))
		}
		if (child.error) lines.push(`Error: ${child.error}`)
	})
	if (result.parentTreeChanges === undefined) {
		lines.push("", "Parent working tree check: git status of the parent repository could not be compared.")
	} else if (result.parentTreeChanges.length) {
		lines.push(
			"",
			"WARNING: the parent working tree changed during the batch (git status --porcelain differences). A child or another process may have written outside its worktree. Review these files:",
			...result.parentTreeChanges.map((line) => `- ${line}`),
		)
	}
	return lines.join("\n")
}
