import type { ClineMessage, HistoryItem } from "@roo-code/types"

/** Match the prompt actually given to the child, including new_task's unescaping. */
export function newTaskContent(message: ClineMessage): string | undefined {
	if (message.type !== "ask" || message.ask !== "tool" || message.partial) return undefined
	try {
		const tool = JSON.parse(message.text ?? "")
		if (tool?.tool === "newTask" && typeof tool.content === "string" && tool.content.length > 0)
			return tool.content.replace(/\\\\@/g, "\\@")
	} catch {
		// Malformed or truncated tool messages cannot establish a link.
	}
	return undefined
}

/**
 * Recover old cards once, from the full saved history before webview pagination.
 * Array offsets are not identities: denied/deleted tasks and bounded windows
 * make childIds[n] unsafe. Ambiguous legacy prompts deliberately remain unlinked.
 * Existing durable IDs always win. This does not change task completion state.
 */
export function recoverSubtaskLinks(
	messages: ClineMessage[],
	parentTaskId: string,
	history: HistoryItem[],
): ClineMessage[] {
	const children = history.filter((item) => item.parentTaskId === parentTaskId)
	const childById = new Map(children.map((child) => [child.id, child]))
	const childrenByPrompt = new Map<string, HistoryItem[]>()
	for (const child of children) {
		const matches = childrenByPrompt.get(child.task) ?? []
		matches.push(child)
		childrenByPrompt.set(child.task, matches)
	}
	const prompts = messages.map(newTaskContent)
	const counts = new Map<string, number>()
	for (const prompt of prompts) if (prompt !== undefined) counts.set(prompt, (counts.get(prompt) ?? 0) + 1)
	let pendingChildId: string | undefined
	return messages.map((message, index) => {
		const prompt = prompts[index]
		let subtaskId = message.subtaskId
		if (prompt !== undefined) {
			const matches = childrenByPrompt.get(prompt)
			if (!subtaskId && counts.get(prompt) === 1 && matches?.length === 1 && message.isAnswered !== false)
				subtaskId = matches[0].id
			pendingChildId = subtaskId
		} else if (message.type === "say" && message.say === "subtask_result") {
			if (!subtaskId && pendingChildId && childById.get(pendingChildId)?.status === "completed")
				subtaskId = pendingChildId
			pendingChildId = undefined
		}
		return subtaskId && subtaskId !== message.subtaskId ? { ...message, subtaskId } : message
	})
}
