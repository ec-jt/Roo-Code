import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	modelOperationSchema,
	modelOperationApprovalSchema,
	modelOperationStatusSchema,
	type ModelOperation,
	type ModelOperationState,
	type ModelOperationStatus,
	type ClineMessage,
} from "@roo-code/types"

import { safeWriteJson } from "../../../utils/safeWriteJson"
import { readRequestSnapshot, type BranchProvenance, type RequestSnapshot } from "./storage"
import { normalizeSnapshotMessages } from "./normalization"

/** Historical eligibility must inspect Task's private runtime counters, not live readiness. */
export interface HistoricalModelOperationTask {
	getHistoricalModelOperationBlockReason(): string | undefined
	stopForHistoricalModelOperation(expectedRevision: number): Promise<void>
}

export interface ModelOperationTask {
	readonly taskId: string
	readonly instanceId: string
	readonly cwd: string
	readonly modelOperationState: ModelOperationState
	readonly modelOperationDispatchClosed: boolean
	readonly parentTaskId?: string
	readonly rootTaskId?: string
	readonly childTaskId?: string
	readonly pendingNewTaskToolCallId?: string
	readonly isPaused: boolean
	readonly clineMessages: ClineMessage[]
	readonly apiConversationHistory: { role: string; requestId?: string }[]
	/** Current response only; Task clears counts after a validated, durable settled boundary. */
	getModelOperationEvidence(): { toolsAdmitted: number; toolsExecuted: number }
	stopForModelOperation(revision: number): Promise<void>
	prepareModelOperationPrefix(
		snapshot: RequestSnapshot,
		profileId: string,
		provenance: BranchProvenance,
	): Promise<void>
	startModelOperationPrefix(): void
	respondToModelOperationApproval(payload: unknown): boolean
}

export interface ModelOperationHost<T extends ModelOperationTask> {
	getCurrentTask(): T | undefined
	getStorageRoot(): Promise<string>
	getWorkspacePath(): string | undefined
	/** Must also reject persisted graph links and waiting/delegated history entries. */
	validateStandalone(task: T): Promise<void>
	/** Direct saved-profile lookup, policy and context checks, without global activation. */
	createBranch(source: T, snapshot: RequestSnapshot, profileId: string): Promise<T>
	/** Synchronous compare-and-replace; never normal abort/remove/resume. */
	activateBranch(source: T, branch: T): void
	discardBranch(branch: T): void
	postStatus(status: ModelOperationStatus): Promise<unknown>
	postState(): Promise<unknown>
}

export class ModelOperationBlocked extends Error {}
const Blocked = ModelOperationBlocked
type Receipt = { version: 1; fingerprint: string; status: ModelOperationStatus }

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code
}

async function syncFile(file: string): Promise<void> {
	const handle = await fs.open(file, "r")
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function syncReceipt(root: string, file: string): Promise<void> {
	await syncFile(file)
	if (process.platform === "win32") return
	const storageRoot = path.resolve(root)
	let directory = path.dirname(path.resolve(file))
	while (true) {
		await syncFile(directory)
		if (directory === storageRoot) break
		directory = path.dirname(directory)
	}
}

function responseId(payload: unknown, field: "operationId" | "approvalId"): string {
	if (payload && typeof payload === "object" && field in payload) {
		const value = (payload as Record<string, unknown>)[field]
		if (typeof value === "string" && value.trim().length) return value
	}
	return `invalid-model-operation${field === "approvalId" ? "-approval" : ""}`
}

/** One queue per provider. The durable claim also excludes other coordinator instances. */
export class ModelOperationCoordinator<T extends ModelOperationTask> {
	private queue: Promise<unknown> = Promise.resolve()
	private readonly receipts = new Map<string, Receipt>()

	constructor(private readonly host: ModelOperationHost<T>) {}

	private serialize<R>(run: () => Promise<R>): Promise<R> {
		const result = this.queue.then(run, run)
		this.queue = result.catch(() => {})
		return result
	}

	private async publish(status: ModelOperationStatus): Promise<ModelOperationStatus> {
		// Delivery failure must not change an already committed operation receipt.
		await this.host.postStatus(status).catch(() => {})
		return status
	}

	run(payload: unknown): Promise<ModelOperationStatus> {
		const parsed = modelOperationSchema.safeParse(payload)
		if (!parsed.success) {
			return this.publish({
				operationId: responseId(payload, "operationId"),
				status: "blocked",
				message:
					"Invalid model operation. Supply explicit task, instance, revision, profile and operation identities.",
			})
		}
		return this.serialize(() => this.executeOnce(parsed.data))
	}

	respondToApproval(payload: unknown): Promise<ModelOperationStatus> {
		return this.serialize(async () => {
			const parsed = modelOperationApprovalSchema.safeParse(payload)
			const task = this.host.getCurrentTask()
			const accepted = !!(parsed.success && task?.respondToModelOperationApproval(parsed.data))
			const status: ModelOperationStatus = {
				operationId: responseId(payload, "approvalId"),
				status: accepted ? "completed" : "blocked",
				message: accepted
					? "Model-operation approval response accepted."
					: "Invalid or stale model-operation approval. Refresh task state; normal ask approval is not a substitute.",
				...(task ? this.identity(task) : {}),
			}
			await this.host.postState().catch(() => {})
			return this.publish(status)
		})
	}

	private identity(task: T) {
		return { taskId: task.taskId, instanceId: task.instanceId, revision: task.modelOperationState.revision }
	}

	private prior(receipt: Receipt, fingerprint: string, operationId: string): ModelOperationStatus {
		if (receipt.fingerprint !== fingerprint || receipt.status.operationId !== operationId) {
			return {
				operationId,
				status: "blocked",
				message: "Operation ID collision. Use a new operation ID for different input.",
			}
		}
		if (receipt.status.status === "running") {
			return {
				operationId,
				status: "blocked",
				message:
					"An operation receipt is still running or was interrupted. Automatic replay is disabled; inspect the current task before issuing a new operation.",
			}
		}
		return receipt.status
	}

	private async readReceipt(file: string): Promise<Receipt | undefined> {
		try {
			const value = JSON.parse(await fs.readFile(file, "utf8")) as Receipt
			if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error("Invalid receipt")
			return {
				version: 1,
				fingerprint: value.fingerprint,
				status: modelOperationStatusSchema.parse(value.status),
			}
		} catch (error) {
			if (hasCode(error, "ENOENT")) return undefined
			throw new Blocked("The operation receipt is unreadable or corrupt. Automatic replay is disabled.")
		}
	}

	private async executeOnce(operation: ModelOperation): Promise<ModelOperationStatus> {
		const { operationId } = operation
		const fingerprint = createHash("sha256").update(JSON.stringify(operation)).digest("hex")
		const cached = this.receipts.get(operationId)
		if (cached) return this.publish(this.prior(cached, fingerprint, operationId))
		let file: string | undefined
		let storageRoot: string | undefined
		let claimed = false
		let status: ModelOperationStatus = {
			operationId,
			status: "running",
			message: "Preparing standalone model-operation branch.",
		}
		try {
			const root = await this.host.getStorageRoot()
			storageRoot = root
			const key = createHash("sha256").update(operationId).digest("hex")
			file = path.join(root, "model-operation", "operations", `${key}.json`)
			const previous = await this.readReceipt(file)
			if (previous) return this.publish(this.prior(previous, fingerprint, operationId))
			const receipt: Receipt = { version: 1, fingerprint, status }
			// Atomic no-overwrite claim, including across provider instances. Never execute without it.
			const staging = `${file}.${randomUUID()}.pending`
			try {
				await safeWriteJson(staging, receipt)
				await syncFile(staging)
				try {
					await fs.link(staging, file)
					claimed = true
					// Persist newly created ancestor entries before any effect or activation.
					await syncReceipt(root, file)
				} catch (error) {
					if (!hasCode(error, "EEXIST")) throw error
					const winner = await this.readReceipt(file)
					if (!winner) throw new Blocked("Operation claim disappeared; automatic replay is disabled.")
					return this.publish(this.prior(winner, fingerprint, operationId))
				}
			} finally {
				await fs.rm(staging, { force: true })
			}
			this.receipts.set(operationId, receipt)
			await this.publish(status)
			status = await this.perform(operation, root)
		} catch (error) {
			status = {
				operationId,
				status: error instanceof Blocked ? "blocked" : "failed",
				// Do not leak provider configuration or credential-bearing exception text.
				message:
					error instanceof Blocked
						? error.message
						: "Model operation failed safely. Inspect task state before retrying with a new operation ID.",
			}
		}
		if (claimed && file && storageRoot) {
			const receipt: Receipt = { version: 1, fingerprint, status }
			try {
				await safeWriteJson(file, receipt)
				await syncReceipt(storageRoot, file)
				this.receipts.set(operationId, receipt)
			} catch {
				status = {
					...status,
					status: "failed",
					message:
						"Could not persist the final receipt. The branch may already be active; automatic replay is disabled.",
				}
				// Keep the running receipt in memory and on disk to fail closed.
			}
		}
		await this.host.postState().catch(() => {})
		return this.publish(status)
	}

	private checkSource(source: T, operation: ModelOperation, revision = operation.revision): void {
		if (
			this.host.getCurrentTask() !== source ||
			source.taskId !== operation.taskId ||
			source.instanceId !== operation.instanceId ||
			source.modelOperationState.revision !== revision
		)
			throw new Blocked("Stale task, instance or revision. Refresh task state before retrying.")
		if (
			source.parentTaskId ||
			source.rootTaskId ||
			source.childTaskId ||
			source.pendingNewTaskToolCallId ||
			source.isPaused
		) {
			throw new Blocked(
				"Task graph operations are on HOLD. Parent, child, delegated and waiting-parent tasks cannot be replayed.",
			)
		}
		if (!this.host.getWorkspacePath() || this.host.getWorkspacePath() !== source.cwd) {
			throw new Blocked(
				"The current workspace differs from the loaded task. Open its workspace and confirm again.",
			)
		}
	}

	private async perform(operation: ModelOperation, root: string): Promise<ModelOperationStatus> {
		if (!operation.confirmCurrentWorkspace)
			throw new Blocked(
				"Confirm use of the current workspace. Regeneration does not restore files or external state.",
			)
		const source = this.host.getCurrentTask()
		if (!source) throw new Blocked("Load the standalone source task before requesting a model operation.")
		this.checkSource(source, operation)
		await this.host.validateStandalone(source)
		this.checkSource(source, operation)
		const historical = source as T & Partial<HistoricalModelOperationTask>
		let requestId: string
		if (operation.kind === "regenerate") {
			if (
				!operation.requestId ||
				!source.clineMessages.some(
					(row) =>
						row.type === "say" &&
						row.say === "text" &&
						!!row.text &&
						!row.partial &&
						row.requestId === operation.requestId,
				) ||
				!source.apiConversationHistory.some(
					(row) => row.role === "assistant" && row.requestId === operation.requestId,
				)
			) {
				throw new Blocked(
					"Select a genuine completed assistant text response with a request ID. Legacy or synthetic rows cannot be regenerated.",
				)
			}
			if (!historical.getHistoricalModelOperationBlockReason || !historical.stopForHistoricalModelOperation) {
				throw new Blocked(
					"Historical regeneration requires the Task historical-quiescence fence, which is unavailable in this runtime.",
				)
			}
			const reason = historical.getHistoricalModelOperationBlockReason()
			if (reason) throw new Blocked(reason)
			requestId = operation.requestId
		} else {
			const evidence = source.getModelOperationEvidence()
			if (evidence.toolsAdmitted || evidence.toolsExecuted)
				throw new Blocked(
					"Tools have been admitted or executed in the current response. Wait for settlement and retry at the next request.",
				)
			const state = source.modelOperationState
			if (state.readiness !== "ready" || !state.requestId)
				throw new Blocked(state.reason ?? "No durable live request is ready to switch.")
			if (operation.requestId && operation.requestId !== state.requestId)
				throw new Blocked("The live request changed. Refresh task state.")
			requestId = state.requestId
		}
		const snapshot = await readRequestSnapshot(root, source.taskId, requestId)
		this.checkSource(source, operation)
		if (!snapshot)
			throw new Blocked("No durable snapshot exists for this request. Legacy history cannot be replayed safely.")
		try {
			normalizeSnapshotMessages(snapshot.apiMessages)
		} catch {
			throw new Blocked(
				"The saved request contains unsupported content or incomplete tool pairs. No effects will be replayed.",
			)
		}
		let branch: T | undefined
		let activated = false
		try {
			branch = await this.host.createBranch(source, snapshot, operation.profileId)
			this.checkSource(source, operation)
			const provenance: BranchProvenance = {
				version: 1,
				operationId: operation.operationId,
				kind: operation.kind,
				sourceTaskId: source.taskId,
				sourceRequestId: requestId,
				targetProfileId: operation.profileId,
				createdAt: Date.now(),
				workspacePath: source.cwd,
				requiresToolApproval: true,
			}
			await branch.prepareModelOperationPrefix(snapshot, operation.profileId, provenance)
			this.checkSource(source, operation)
			await this.host.validateStandalone(source)
			this.checkSource(source, operation)
			if (operation.kind === "regenerate") {
				const reason = historical.getHistoricalModelOperationBlockReason!()
				if (reason) throw new Blocked(reason)
				await historical.stopForHistoricalModelOperation!(operation.revision)
			} else {
				const evidence = source.getModelOperationEvidence()
				if (evidence.toolsAdmitted || evidence.toolsExecuted)
					throw new Blocked(
						"Tools were admitted during preparation. Wait for settlement and retry at the next request.",
					)
				const state = source.modelOperationState
				if (state.readiness !== "ready")
					throw new Blocked(state.reason ?? "The source is no longer ready to switch.")
				if (state.requestId !== requestId)
					throw new Blocked("The live request changed during preparation. Refresh task state.")
				await source.stopForModelOperation(operation.revision)
			}
			this.checkSource(source, operation, operation.revision + 1)
			if (!source.modelOperationDispatchClosed)
				throw new Blocked("Source dispatch did not close. Replacement activation is blocked.")
			this.host.activateBranch(source, branch)
			activated = true
			branch.startModelOperationPrefix()
			return {
				operationId: operation.operationId,
				status: "completed",
				message: "Prepared standalone branch activated. Model response generation is not yet complete.",
				...this.identity(branch),
			}
		} finally {
			if (branch && !activated) this.host.discardBranch(branch)
		}
	}
}
