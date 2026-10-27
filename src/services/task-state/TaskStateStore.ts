import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
	taskStateDataSchema,
	taskStateDigestSchema,
	taskStateIdSchema,
	taskStatePatchOperationsSchema,
	taskStatePolicySchema,
	taskStateSnapshotSchema,
	taskStateEvidenceSchema,
	type TaskStateData,
	type TaskStateSnapshot,
	type TaskStatePolicy,
	type TaskStatePatchOperation,
} from "../../../packages/types/src/task-state"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { directory, hash, locked, missing, readText, regularFile } from "../memory/files"
import { assertNoSecrets } from "../memory/records"
import { MemoryError } from "../memory/types"
import { TASK_STATE_LIMITS, TaskStateError, type TaskStateRead, type TaskStateWriteOptions } from "./types"

const ledgerSchema = z
	.object({
		schemaVersion: z.literal(1),
		taskId: taskStateIdSchema,
		workspaceId: taskStateDigestSchema,
		revisions: z.array(taskStateSnapshotSchema).min(1).max(TASK_STATE_LIMITS.revisions),
	})
	.strict()
type Ledger = z.infer<typeof ledgerSchema>
const emptyData = (): TaskStateData => ({
	goal: "",
	acceptanceCriteria: [],
	constraints: [],
	decisions: [],
	workItems: [],
	evidenceRefs: [],
	failedApproaches: [],
	blockers: [],
	nextAction: "",
})
const defaultPolicy = () => taskStatePolicySchema.parse({})
const fail = (code: string, message: string): never => {
	throw new TaskStateError(code, message)
}

/** Stable digest independent of object key insertion order. Not a signature or proof of truth. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`
	return JSON.stringify(value)
}

/** Public errors contain fixed messages only, never raw JSON, paths, callback errors, or Zod inputs. */
async function protect<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation()
	} catch (error) {
		if (error instanceof TaskStateError) throw error
		if (error instanceof z.ZodError && error.issues.some((issue) => issue.code === "too_big"))
			throw new TaskStateError("LIMIT", "Task state input exceeds its field or record limit")
		if (error instanceof MemoryError) {
			const code = ["LIMIT", "SECRET", "UNSAFE_PATH", "UNSAFE_FILE", "LOCK_LOST", "CONFLICT"].includes(error.code)
				? error.code
				: "INVALID_STATE"
			throw new TaskStateError(code, "Task state operation rejected by storage safety checks")
		}
		throw new TaskStateError("INVALID_STATE", "Task state operation failed; state or storage is unavailable")
	}
}

function validateData(data: TaskStateData): void {
	for (const records of Object.values(data)) {
		if (!Array.isArray(records)) continue
		if (new Set(records.map((record) => record.id)).size !== records.length)
			fail("INVALID_STATE", "Duplicate task state record IDs")
	}
	const ids = new Set(data.evidenceRefs.map((record) => record.id))
	if (data.workItems.some((item) => item.evidenceIds.some((id) => !ids.has(id))))
		fail("INVALID_STATE", "Work item references missing evidence")
	assertNoSecrets(canonical(data))
}

/** Caller supplies an already resolved, existing task directory. No workspace files are accessed. */
export class TaskStateStore {
	readonly taskDir: string
	readonly taskId: string
	readonly workspaceId: string
	private readonly file: string

	constructor(options: { taskDir: string; taskId: string; cwd: string }) {
		if (
			!taskStateIdSchema.safeParse(options.taskId).success ||
			!path.isAbsolute(options.taskDir) ||
			!path.isAbsolute(options.cwd)
		)
			fail("IDENTITY", "Task state requires a task ID and absolute resolved paths")
		this.taskDir = path.resolve(options.taskDir)
		this.taskId = options.taskId
		this.workspaceId = hash(path.resolve(options.cwd))
		this.file = path.join(this.taskDir, "task-state.json")
	}

	private digest(snapshot: Omit<TaskStateSnapshot, "revision">): string {
		return hash(canonical({ taskId: this.taskId, workspaceId: this.workspaceId, snapshot }))
	}

	private async load(): Promise<Ledger | null> {
		const text = await readText(this.file, TASK_STATE_LIMITS.storeBytes)
		if (text === undefined) return null
		const ledger = ledgerSchema.parse(JSON.parse(text))
		if (ledger.taskId !== this.taskId || ledger.workspaceId !== this.workspaceId)
			fail("IDENTITY", "Task state identity does not match")
		let parent: string | null = null
		const seen = new Set<string>()
		for (const [index, snapshot] of ledger.revisions.entries()) {
			const { revision, ...content } = snapshot
			if (
				snapshot.sequence !== index + 1 ||
				snapshot.parentRevision !== parent ||
				(snapshot.baseRevision !== null && !seen.has(snapshot.baseRevision)) ||
				revision !== this.digest(content)
			)
				fail("INVALID_STATE", "Task state revision integrity check failed")
			if (Buffer.byteLength(canonical(snapshot)) > TASK_STATE_LIMITS.snapshotBytes)
				fail("LIMIT", "Task state snapshot exceeds its byte limit")
			validateData(snapshot.data)
			assertNoSecrets(canonical(snapshot.policy))
			seen.add(revision)
			parent = revision
		}
		return ledger
	}

	private select(ledger: Ledger | null, anchors: readonly string[]): TaskStateRead {
		if (!Array.isArray(anchors) || anchors.some((anchor) => !taskStateDigestSchema.safeParse(anchor).success))
			fail("INVALID_STATE", "Invalid task history anchors")
		const valid = new Set(anchors)
		const head = ledger?.revisions.at(-1)
		const snapshot = ledger
			? ([...ledger.revisions].reverse().find((revision) => valid.has(revision.historyAnchor)) ?? null)
			: null
		return { revision: head?.revision ?? null, snapshot, policy: head?.policy ?? defaultPolicy() }
	}

	read(validHistoryAnchors: readonly string[]): Promise<TaskStateRead> {
		return protect(async () => this.select(await this.load(), validHistoryAnchors))
	}

	private write(
		options: TaskStateWriteOptions,
		actor: TaskStateSnapshot["actor"],
		initialize: boolean,
		change: (
			data: TaskStateData,
			selected: TaskStateRead,
		) => { data: TaskStateData; policy?: TaskStatePolicy; forkedFrom?: TaskStateSnapshot["forkedFrom"] },
		allowNativeRebase = false,
	): Promise<TaskStateRead> {
		return protect(async () => {
			if (
				!taskStateDigestSchema.safeParse(options.historyAnchor).success ||
				!options.validHistoryAnchors.includes(options.historyAnchor)
			)
				fail("HISTORY_CONFLICT", "Current history anchor must be in the compatible history set")
			if (options.expectedRevision !== null && !taskStateDigestSchema.safeParse(options.expectedRevision).success)
				fail("CONFLICT", "An expected task state revision is required")
			if (!(await directory(this.taskDir))) fail("UNSAFE_PATH", "Task directory must already exist")
			return locked(`${this.file}.transaction`, async (assertLock) => {
				const ledger = await this.load()
				const selected = this.select(ledger, options.validHistoryAnchors)
				if (selected.revision !== options.expectedRevision)
					fail("CONFLICT", "Task state changed; reread before retrying")
				if (initialize && ledger) fail("CONFLICT", "Task state is already initialized")
				if (!initialize && !ledger) fail("NOT_INITIALIZED", "Task state must be explicitly initialized")
				if (!initialize && !selected.snapshot && !allowNativeRebase)
					fail("HISTORY_CONFLICT", "No state revision matches current history")
				const changed = change(
					selected.snapshot ? structuredClone(selected.snapshot.data) : emptyData(),
					selected,
				)
				const data = taskStateDataSchema.parse(changed.data)
				validateData(data)
				const policy = taskStatePolicySchema.parse(changed.policy ?? selected.policy)
				if (new Set(policy.checks.map((check) => check.id)).size !== policy.checks.length)
					fail("INVALID_STATE", "Duplicate acceptance check IDs")
				assertNoSecrets(canonical(policy))
				const content: Omit<TaskStateSnapshot, "revision"> = {
					schemaVersion: 1,
					sequence: (ledger?.revisions.length ?? 0) + 1,
					parentRevision: selected.revision,
					baseRevision: selected.snapshot?.revision ?? null,
					historyAnchor: options.historyAnchor,
					...(options.historyPosition !== undefined ? { historyPosition: options.historyPosition } : {}),
					createdAt: new Date().toISOString(),
					actor,
					data,
					policy,
					...(changed.forkedFrom || selected.snapshot?.forkedFrom
						? { forkedFrom: changed.forkedFrom ?? selected.snapshot?.forkedFrom }
						: {}),
				}
				const snapshot = taskStateSnapshotSchema.parse({ ...content, revision: this.digest(content) })
				const next: Ledger = {
					schemaVersion: 1,
					taskId: this.taskId,
					workspaceId: this.workspaceId,
					revisions: [...(ledger?.revisions ?? []), snapshot],
				}
				if (
					next.revisions.length > TASK_STATE_LIMITS.revisions ||
					Buffer.byteLength(canonical(snapshot)) > TASK_STATE_LIMITS.snapshotBytes ||
					Buffer.byteLength(canonical(next)) > TASK_STATE_LIMITS.storeBytes
				)
					fail("LIMIT", "Task state storage limit reached; no revisions or constraints were discarded")
				try {
					await options.authorize()
				} catch {
					fail("REFUSED", "Task state write authorization was refused")
				}
				assertLock()
				// Recheck paths and revision after asynchronous authorization. Stage in the private lock
				// directory so safeWriteJson's default umask cannot expose new state before chmod.
				await directory(this.taskDir)
				await regularFile(this.file)
				const current = await this.load()
				if ((current?.revisions.at(-1)?.revision ?? null) !== selected.revision)
					fail("CONFLICT", "Task state changed before commit")
				const lockDir = `${this.file}.transaction.lock`
				await directory(lockDir)
				await fs.chmod(lockDir, 0o700)
				const stage = path.join(lockDir, `${randomUUID()}.json`)
				let mode = 0o600
				try {
					mode &= (await fs.lstat(this.file)).mode
				} catch (error) {
					if (!missing(error)) throw error
				}
				try {
					await safeWriteJson(stage, next)
					await fs.chmod(stage, mode)
					assertLock()
					await directory(this.taskDir)
					await regularFile(this.file)
					await fs.rename(stage, this.file)
				} finally {
					await fs.unlink(stage).catch((error) => {
						if (!missing(error)) throw error
					})
				}
				return this.select(next, options.validHistoryAnchors)
			})
		})
	}

	/** Native/user entry point only. The model patch tool must never call initialize. */
	initialize(options: TaskStateWriteOptions & { operations?: TaskStatePatchOperation[] }): Promise<TaskStateRead> {
		return this.write(options, "user", true, (data) => ({
			data: this.apply(data, options.operations ?? [], "user"),
		}))
	}

	patch(options: TaskStateWriteOptions & { operations: TaskStatePatchOperation[] }): Promise<TaskStateRead> {
		return this.write(options, "model", false, (data) => ({ data: this.apply(data, options.operations, "model") }))
	}

	/** Explicit native correction. Never exposed through the model tool. */
	correct(options: TaskStateWriteOptions & { operations: TaskStatePatchOperation[] }): Promise<TaskStateRead> {
		return this.write(
			options,
			"user",
			false,
			(data) => ({ data: this.apply(data, options.operations, "user") }),
			true,
		)
	}

	private apply(data: TaskStateData, operations: TaskStatePatchOperation[], actor: "user" | "model"): TaskStateData {
		if (!operations.length && actor === "user") return data
		for (const operation of taskStatePatchOperationsSchema.parse(operations)) {
			if (operation.op === "set") {
				data[operation.field] = operation.value
				continue
			}
			const records = data[operation.collection] as Array<{ id: string; text: string }>
			const id = operation.op === "remove" ? operation.id : operation.value.id
			const index = records.findIndex((record) => record.id === id)
			if (
				operation.collection === "evidenceRefs" &&
				index !== -1 &&
				data.evidenceRefs[index].provenance === "runtime_observed"
			)
				fail("PROVENANCE", "Runtime evidence is immutable to model patches")
			if (operation.op === "remove") {
				if (index !== -1) records.splice(index, 1)
				continue
			}
			const value =
				operation.collection === "evidenceRefs"
					? { ...operation.value, provenance: actor === "model" ? "model_claim" : "user_claim" }
					: operation.value
			if (index === -1) records.push(value)
			else records[index] = value
		}
		return data
	}

	/** Native-only policy configuration. Never dispatch this method from model-provided arguments. */
	configurePolicy(options: TaskStateWriteOptions & { policy: TaskStatePolicy }): Promise<TaskStateRead> {
		return this.write(options, "user", false, (data) => ({ data, policy: options.policy }), true)
	}

	/** Runtime-only append. Existing evidence cannot be replaced, including model claims. */
	appendRuntimeEvidence(
		options: TaskStateWriteOptions & { evidence: { id: string; text: string; source: string } },
	): Promise<TaskStateRead> {
		return this.write(options, "runtime", false, (data) => {
			const input = taskStateEvidenceSchema
				.omit({ provenance: true, observedAt: true })
				.strict()
				.parse(options.evidence)
			if (data.evidenceRefs.some((record) => record.id === input.id))
				fail("CONFLICT", "Evidence ID already exists")
			data.evidenceRefs.push({ ...input, provenance: "runtime_observed", observedAt: new Date().toISOString() })
			return { data }
		})
	}

	/** Explicit native fork. Read source through its store; do not accept a model-supplied snapshot. */
	forkFrom(
		options: TaskStateWriteOptions & {
			source: TaskStateStore
			sourceValidHistoryAnchors: readonly string[]
			sourceRevision: string
		},
	): Promise<TaskStateRead> {
		return protect(async () => {
			const source = await options.source.read(options.sourceValidHistoryAnchors)
			if (!source.snapshot || source.snapshot.revision !== options.sourceRevision)
				fail("HISTORY_CONFLICT", "Fork source revision is not compatible with source history")
			if (this.workspaceId !== options.source.workspaceId || this.taskId === options.source.taskId)
				fail("IDENTITY", "Fork requires a different task in the same workspace")
			const snapshot = source.snapshot!
			return this.write(options, "user", true, () => ({
				data: structuredClone(snapshot.data),
				policy: defaultPolicy(),
				forkedFrom: {
					taskId: options.source.taskId,
					workspaceId: options.source.workspaceId,
					revision: snapshot.revision,
					historyAnchor: snapshot.historyAnchor,
				},
			}))
		})
	}
}

export function getTaskStateStore(options: { taskDir: string; taskId: string; cwd: string }): TaskStateStore {
	return new TaskStateStore(options)
}
