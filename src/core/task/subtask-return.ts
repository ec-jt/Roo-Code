import type { ClineMessage, HistoryItem } from "@roo-code/types"
import type { ApiMessage } from "../task-persistence"
import { newTaskContent } from "./subtask-links"

/**
 * Opening a parent for inspection revokes its pending-return metadata before
 * the user answers the resume prompt. Recover only when both saved histories
 * still end at the exact unanswered delegation to this child.
 */
export function canRecoverSubtaskReturn(
	parent: HistoryItem,
	child: HistoryItem,
	messages: ClineMessage[],
	apiMessages: ApiMessage[],
): boolean {
	if (
		parent.id === child.id ||
		parent.status !== "active" ||
		parent.awaitingChildId !== undefined ||
		parent.delegatedToId !== child.id ||
		parent.childIds?.at(-1) !== child.id ||
		parent.completedByChildId === child.id ||
		child.parentTaskId !== parent.id ||
		child.awaitingChildId ||
		(child.status !== undefined && child.status !== "active")
	)
		return false

	let index = messages.length - 1
	while (index >= 0 && messages[index].type === "ask" && messages[index].ask === "resume_task") index--
	const creation = messages[index]
	if (
		!creation ||
		creation.subtaskId !== child.id ||
		creation.isAnswered === false ||
		newTaskContent(creation) !== child.task
	)
		return false

	const last = apiMessages.at(-1)
	if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return false
	const tools = last.content.filter((block) => block.type === "tool_use")
	if (tools.length !== 1 || tools[0].name !== "new_task") return false
	const input = tools[0].input as { message?: unknown } | null
	return typeof input?.message === "string" && input.message.replace(/\\\\@/g, "\\@") === child.task
}
