import * as vscode from "vscode"
import * as path from "node:path"
import * as fs from "node:fs/promises"
import type { Task } from "../../core/task/Task"
import type { TaskStatePatchOperation } from "../../../packages/types/src/task-state"
import { getTaskDirectoryPath } from "../../utils/storage"
import { getTaskStateStore, type TaskStateStore } from "./TaskStateStore"
import { taskHistoryAnchors, taskStateRecall, stateHash } from "./history"
import { renderTaskState } from "./render"
import { TaskStateError } from "./types"

const stores = new WeakMap<Task, Promise<TaskStateStore>>()
const directories = new WeakMap<Task, Promise<string>>()
const pins = new WeakMap<Task, { revision: string; anchor: string }>()

function taskDirectory(task: Task, storage: string) {
	let directory = directories.get(task)
	if (!directory) {
		directory = getTaskDirectoryPath(storage, task.taskId)
		directories.set(task, directory)
	}
	return directory
}

/** An absent ledger is off, including in untrusted workspaces and legacy tasks. */
export async function hasTaskState(task: Task): Promise<boolean> {
	const storage = task.providerRef?.deref()?.contextProxy?.globalStorageUri?.fsPath
	if (!storage) return false
	const taskDir = await taskDirectory(task, storage)
	try {
		await fs.lstat(path.join(taskDir, "task-state.json"))
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

export function assertTaskStateOpen(task: Task) {
	if (vscode.workspace.isTrusted !== true)
		throw new TaskStateError("UNTRUSTED", "Task state requires workspace trust")
	if (
		task.abort ||
		task.abandoned ||
		task.modelOperationDispatchClosed ||
		task.providerRef.deref()?.getCurrentTask() !== task
	)
		throw new TaskStateError("CLOSED", "Task state requires the current open task")
}

export function assertTaskStateAccess(task: Task, store: TaskStateStore) {
	assertTaskStateOpen(task)
	for (const file of [
		store.taskDir,
		path.join(store.taskDir, "task-state.json"),
		path.join(store.taskDir, "task-state-runtime.json"),
	]) {
		if (!task.rooIgnoreController?.validateAccess(file) || task.rooProtectedController?.isWriteProtected(file))
			throw new TaskStateError("ACCESS_DENIED", "Task state storage is restricted by workspace policy")
	}
}

export async function taskStateStore(task: Task): Promise<TaskStateStore> {
	assertTaskStateOpen(task)
	let store = stores.get(task)
	if (!store) {
		store = (async () => {
			const provider = task.providerRef.deref()
			if (!provider) throw new TaskStateError("CLOSED", "Task provider is unavailable")
			const taskDir = await taskDirectory(task, provider.contextProxy.globalStorageUri.fsPath)
			return getTaskStateStore({ taskDir, taskId: task.taskId, cwd: task.cwd })
		})()
		stores.set(task, store)
	}
	const result = await store
	assertTaskStateAccess(task, result)
	return result
}

export async function taskStateTransaction(task: Task, expectedRevision: string | null) {
	const store = await taskStateStore(task)
	const history = taskHistoryAnchors(task.apiConversationHistory)
	const epoch = task.taskStateEpoch
	return {
		store,
		options: {
			expectedRevision,
			historyAnchor: history.anchor,
			historyPosition: history.position,
			validHistoryAnchors: history.anchors,
			authorize: async () => {
				assertTaskStateAccess(task, store)
				if (
					task.taskStateEpoch !== epoch ||
					taskHistoryAnchors(task.apiConversationHistory).anchor !== history.anchor
				)
					throw new TaskStateError("STALE", "Task or history changed during task-state operation")
			},
		},
	}
}

/** Capture once before pinning. Malformed or inaccessible state fails closed, not silently recalled. */
export async function pinTaskStateRecall(task: Task): Promise<string> {
	pins.delete(task)
	if (!(await hasTaskState(task))) return ""
	const store = await taskStateStore(task)
	const history = taskHistoryAnchors(task.apiConversationHistory)
	const state = await store.read(history.anchors)
	if (!state.revision || !state.policy.recallEnabled) return ""
	if (!state.snapshot)
		throw new TaskStateError(
			"HISTORY_CONFLICT",
			"Task state has no compatible history; review it before continuing",
		)
	pins.set(task, { revision: state.revision, anchor: state.snapshot.historyAnchor })
	return taskStateRecall(renderTaskState(state.snapshot))
}

/** Validate consent/identity only. Never replace the captured recall with a newer snapshot. */
export async function assertTaskStateDispatch(task: Task) {
	const pin = pins.get(task)
	if (!pin) return
	const store = await taskStateStore(task)
	const history = taskHistoryAnchors(task.apiConversationHistory)
	const current = await store.read(history.anchors)
	if (!current.policy.recallEnabled || current.revision !== pin.revision || !history.anchors.includes(pin.anchor))
		throw new TaskStateError("STALE", "Task state changed while the request was pinned; prepare a new request")
}

/** Bounded evidence records references and digests, never copies raw tool output. */
export async function recordTaskStateMilestone(task: Task): Promise<void> {
	const store = await taskStateStore(task)
	const history = taskHistoryAnchors(task.apiConversationHistory)
	const current = await store.read(history.anchors)
	if (!current.snapshot || !current.policy.recallEnabled) return
	const last = [...task.apiConversationHistory]
		.reverse()
		.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"))
	if (!last || !Array.isArray(last.content)) return
	const results = last.content.filter((b) => b.type === "tool_result")
	const digest = stateHash(JSON.stringify(results))
	const id = `tools-${digest}`
	if (current.snapshot.data.evidenceRefs.some((e) => e.id === id)) return
	const { options } = await taskStateTransaction(task, current.revision)
	await store.appendRuntimeEvidence({
		...options,
		evidence: {
			id,
			text: `Observed ${results.length} tool-result blocks. SHA-256 ${digest}. This records receipt, not success or acceptance.`,
			source: `task:${task.taskId};history:${history.anchor};position:${history.position}`,
		},
	})
}

/** Sync only todo-owned items, and never replace a manually changed ledger item. */
export async function syncTaskStateTodos(
	task: Task,
	previous: readonly { id: string; content: string; status: string }[],
) {
	if (!(await hasTaskState(task))) return
	const store = await taskStateStore(task)
	const current = await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)
	if (!current.snapshot || !current.policy.recallEnabled) return
	const operations: TaskStatePatchOperation[] = []
	const status = (s: string) =>
		s === "completed"
			? ("implemented" as const)
			: s === "in_progress"
				? ("in_progress" as const)
				: ("pending" as const)
	for (const todo of task.todoList ?? []) {
		const id = `todo-${todo.id}`
		const item = current.snapshot.data.workItems.find((i) => i.id === id)
		const before = previous.find((t) => t.id === todo.id)
		if (
			item &&
			(!before ||
				item.text !== before.content ||
				item.status !== status(before.status) ||
				item.evidenceIds.length)
		)
			continue
		if (item?.text === todo.content && item.status === status(todo.status)) continue
		operations.push({
			op: "upsert",
			collection: "workItems",
			value: { id, text: todo.content, status: status(todo.status), evidenceIds: [] },
		})
	}
	if (operations.length) {
		const { options } = await taskStateTransaction(task, current.revision)
		await store.patch({ ...options, operations })
	}
}
