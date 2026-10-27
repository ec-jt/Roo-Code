import type { TaskStatePolicy, TaskStateSnapshot } from "../../../packages/types/src/task-state"

export const TASK_STATE_LIMITS = Object.freeze({
	storeBytes: 4 * 1024 * 1024,
	revisions: 200,
	snapshotBytes: 64 * 1024,
	recallChars: 24_000,
})
export class TaskStateError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message)
		this.name = "TaskStateError"
	}
}
export interface TaskStateRead {
	/** CAS token for the whole ledger, even when snapshot is an older compatible revision. */
	revision: string | null
	snapshot: TaskStateSnapshot | null
	/** Latest user-owned policy, never rewound with model state. */
	policy: TaskStatePolicy
}
export interface TaskStateWriteOptions {
	expectedRevision: string | null
	historyAnchor: string
	historyPosition?: number
	validHistoryAnchors: readonly string[]
	/** Called under the transaction lock immediately before persistence. Must recheck live authorization/identity. */
	authorize: () => Promise<void>
}
