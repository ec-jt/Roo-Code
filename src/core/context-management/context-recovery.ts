import * as path from "path"
import * as fs from "fs/promises"
import type { ClineMessage } from "@roo-code/types"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../condense"
import { getStorageBasePath } from "../../utils/storage"
import { saveTaskSnapshot } from "../task-persistence/taskSaves"

export interface ContextRecoverySnapshot {
	version: 1
	taskId: string
	eventId: string
	apiMessages: ApiMessage[]
	clineMessages: ClineMessage[]
}

async function snapshotPath(storage: string, taskId: string, eventId: string) {
	if (!/^[a-zA-Z0-9-]{1,128}$/.test(eventId)) throw new Error("Invalid context event identity")
	return path.join(await getStorageBasePath(storage), "tasks", taskId, "context-recovery", `${eventId}.json`)
}

/** Commit the exact pre-operation history before publishing a context replacement. */
export async function saveContextRecoverySnapshot(storage: string, snapshot: ContextRecoverySnapshot) {
	await snapshotPath(storage, snapshot.taskId, snapshot.eventId)
	await saveTaskSnapshot(
		{ globalStoragePath: storage, taskId: snapshot.taskId, barrier: true },
		path.join("context-recovery", `${snapshot.eventId}.json`),
		() => structuredClone(snapshot),
	)
}

export async function readContextRecoverySnapshot(storage: string, taskId: string, eventId: string) {
	let snapshot: ContextRecoverySnapshot
	try {
		snapshot = JSON.parse(await fs.readFile(await snapshotPath(storage, taskId, eventId), "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				"This older context event has no exact recovery snapshot. Its boundary cannot be recovered safely.",
			)
		}
		throw error
	}
	if (
		snapshot.version !== 1 ||
		snapshot.taskId !== taskId ||
		snapshot.eventId !== eventId ||
		!Array.isArray(snapshot.apiMessages) ||
		!Array.isArray(snapshot.clineMessages)
	) {
		throw new Error("Invalid context recovery snapshot")
	}
	return snapshot
}

/** Fail closed instead of relying on provider-specific orphan-result pruning. */
export function prepareContextRecovery(snapshot: ContextRecoverySnapshot): ContextRecoverySnapshot {
	const copy = structuredClone(snapshot)
	const effective = getEffectiveApiHistory(copy.apiMessages)
	if (!effective.length || effective.some((message) => !copy.apiMessages.includes(message))) {
		throw new Error("Recovery history needs tool-pair repair; the source was not changed.")
	}
	const pending = new Set<string>()
	const seen = new Set<string>()
	for (const message of effective) {
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (block.type === "tool_use") {
				if (message.role !== "assistant" || seen.has(block.id)) throw new Error("Ambiguous recovery tool call")
				seen.add(block.id)
				pending.add(block.id)
			} else if (block.type === "tool_result") {
				if (message.role !== "user" || !pending.delete(block.tool_use_id))
					throw new Error("Unpaired recovery tool result")
			}
		}
	}
	if (pending.size) throw new Error("Recovery history contains unfinished tool calls")
	// Provider response chains and checkpoints belong to the source, never the branch.
	for (const message of copy.apiMessages) delete message.id
	copy.clineMessages = copy.clineMessages.filter(
		(message) =>
			message.say !== "checkpoint_saved" &&
			message.ask !== "resume_task" &&
			message.ask !== "resume_completed_task",
	)
	for (const message of copy.clineMessages) delete message.checkpoint
	return copy
}
