import crypto from "node:crypto"
import type { ApiHandler } from "../../api"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../condense"

type OverflowTruncationResult = {
	messages: ApiMessage[]
	error?: string
	truncationId?: string
	messagesRemoved?: number
	newContextTokens?: number
}

// Treat feedback-looking text conservatively, even when it may be quoted output.
const userFeedback = /<\s*(?:user_message|feedback|answer|user_input)\b/i
const interactiveTools = new Set(["ask_followup_question", "attempt_completion", "new_task", "switch_mode"])

/** Find complete, contiguous tool groups. Never split a parallel call batch. */
function olderToolGroups(messages: ApiMessage[]): ApiMessage[][] {
	const groups: { messages: ApiMessage[]; removable: boolean }[] = []
	for (let i = 1; i < messages.length; i++) {
		const start = messages[i]
		if (start.role !== "assistant" || !Array.isArray(start.content)) continue
		const calls = start.content.filter((block) => block.type === "tool_use")
		if (!calls.length) continue
		const pending = new Set(calls.map((call) => call.id))
		const group = [start]
		let removable = !calls.some((call) => interactiveTools.has(call.name.split(".").at(-1)!))
		for (let j = i + 1; j < messages.length && pending.size; j++) {
			const result = messages[j]
			if (result.role !== "user" || !Array.isArray(result.content)) break
			group.push(result)
			for (const block of result.content) {
				if (block.type === "tool_result") {
					pending.delete(block.tool_use_id)
					const content = block.content
					if (typeof content === "string") {
						if (userFeedback.test(content)) removable = false
					} else if (Array.isArray(content)) {
						// Preserve images and unfamiliar blocks rather than guessing their origin.
						if (content.some((part) => part.type !== "text" || userFeedback.test(part.text)))
							removable = false
					}
				} else if (
					block.type !== "text" ||
					userFeedback.test(block.text) ||
					!/^\s*<environment_details>[\s\S]*<\/environment_details>\s*$/.test(block.text)
				) {
					// User text outside an environment update may be an instruction or approval.
					removable = false
				}
			}
			if (result.isSummary || result.isTruncationMarker) removable = false
		}
		if (!pending.size) groups.push({ messages: group, removable })
	}
	// Keep the newest complete tool interaction, even if it contains no user feedback.
	return groups
		.slice(0, -1)
		.filter((group) => group.removable)
		.map((group) => group.messages)
}

/** Runs only after rejected overflow compaction. Never deletes stored history. */
export async function truncateAfterOverflow({
	messages,
	apiHandler,
	systemPrompt,
	contextWindow,
	maxTokens,
	tools,
}: {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	contextWindow: number
	maxTokens?: number | null
	tools?: unknown
}): Promise<OverflowTruncationResult> {
	const unchanged = (error: string) => ({ messages, error })
	const effective = getEffectiveApiHistory(messages)
	// Refuse mappings where effective-history repair would have changed a message.
	if (effective.some((message) => !messages.includes(message)))
		return unchanged("History needs tool-pair repair before truncation. Compact manually.")
	const visible = effective.filter((message) => !message.isTruncationMarker)
	if (visible.length < 4 || visible[0].role !== "user" || visible.at(-1)?.role !== "user")
		return unchanged("Not enough complete earlier exchanges to truncate safely.")

	// Safe boundaries begin a user turn, with no outstanding tool calls crossing it.
	const boundaries: number[] = []
	const pending = new Set<string>()
	const seen = new Set<string>()
	for (let i = 0; i < visible.length; i++) {
		const message = visible[i]
		const blocks = Array.isArray(message.content) ? message.content : []
		const results = blocks.filter((block) => block.type === "tool_result")
		if (
			i > 0 &&
			message.role === "user" &&
			visible[i - 1].role !== "user" &&
			pending.size === 0 &&
			results.length === 0
		)
			boundaries.push(i)
		for (const block of blocks) {
			if (block.type === "tool_use") {
				if (message.role !== "assistant" || seen.has(block.id))
					return unchanged("Ambiguous tool-call history cannot be truncated safely.")
				seen.add(block.id)
				pending.add(block.id)
			} else if (block.type === "tool_result") {
				if (message.role !== "user" || !pending.delete(block.tool_use_id))
					return unchanged("Unpaired tool results cannot be truncated safely.")
			}
		}
	}
	if (pending.size) return unchanged("Pending tool calls cannot be truncated safely.")
	const latest = boundaries.at(-1)
	const firstRemovable = boundaries[0]
	// Prefer whole older turns. Only fall back to tool groups if those cannot fit.
	const exchanges =
		latest !== undefined && firstRemovable !== latest
			? boundaries.slice(1).map((end, index) => visible.slice(boundaries[index], end))
			: []
	const toolGroups = olderToolGroups(visible)
	if (!exchanges.length && !toolGroups.length)
		return unchanged(
			"No earlier complete exchange can be excluded safely. Nothing was truncated. " +
				"There are no removable older exchanges or complete older tool groups. " +
				"Roo preserves the root/current summary, user input and feedback in retained turns, and the newest tool interaction. " +
				"Use a larger-context model or start a new task with a reviewed handoff. Repeating truncation on unchanged history will not help.",
		)
	const count = async (message: ApiMessage) =>
		apiHandler.countTokens(
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
		)
	const costs: number[] = []
	for (const message of visible) costs.push(await count(message))
	let overhead = await apiHandler.countTokens([
		{ type: "text", text: systemPrompt },
		...(tools ? [{ type: "text" as const, text: JSON.stringify(tools) }] : []),
	])
	for (const message of effective.filter((message) => message.isTruncationMarker)) {
		const markerCost = await count(message)
		if (!Number.isFinite(markerCost) || markerCost < 0)
			return unchanged("Cannot establish a safe post-overflow input size.")
		overhead += markerCost
	}
	const reserve = maxTokens && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8192
	const inputLimit = contextWindow - reserve
	if (
		!Number.isFinite(inputLimit) ||
		inputLimit <= 0 ||
		costs.some((n) => !Number.isFinite(n) || n < 0) ||
		!Number.isFinite(overhead) ||
		overhead < 0
	)
		return unchanged("Cannot establish a safe post-overflow input size.")
	const truncationId = crypto.randomUUID()
	// Count the disclosure marker as part of the next request.
	const markerText =
		"[Older exchanges or completed tool-call/result groups were excluded after overflow compaction failed. " +
		"Excluded content was not summarized and is no longer visible to the model. Original history remains stored.]"
	const markerTokens = await apiHandler.countTokens([{ type: "text", text: markerText }])
	if (!Number.isFinite(markerTokens) || markerTokens < 0)
		return unchanged("Cannot establish a safe post-overflow input size.")
	const target = Math.min(inputLimit, contextWindow * 0.75)
	let remaining = overhead + costs.reduce((a, b) => a + b, 0) + markerTokens
	const costByMessage = new Map(visible.map((message, index) => [message, costs[index]]))
	const excluded = new Set<ApiMessage>()
	const exclude = (group: ApiMessage[]) => {
		for (const message of group) {
			if (!excluded.has(message)) {
				excluded.add(message)
				remaining -= costByMessage.get(message)!
			}
		}
	}
	for (const exchange of exchanges) {
		exclude(exchange)
		if (remaining <= target) break
	}
	// Do not weaken whole-turn protection just to reach the 75% target if it fits.
	if (!excluded.size || remaining > inputLimit) {
		for (const group of toolGroups) {
			exclude(group)
			if (remaining <= target) break
		}
	}
	if (!Number.isFinite(remaining) || remaining > inputLimit)
		return unchanged(
			"The protected task, user feedback, and newest tool interaction are too large. Nothing was truncated. " +
				"Use a larger-context model or start a new task with a reviewed handoff.",
		)
	// Insert before the first excluded group; keep prior markers so their tags stay effective.
	const firstExcluded = visible.find((message) => excluded.has(message))!
	const insertAt = messages.indexOf(firstExcluded)
	const tagged = messages.map((message) =>
		excluded.has(message) ? { ...message, truncationParent: truncationId } : message,
	)
	const marker: ApiMessage = {
		role: "user",
		content: markerText,
		isTruncationMarker: true,
		truncationId,
		ts: (firstExcluded.ts ?? Date.now()) - 1,
	}
	return {
		messages: [...tagged.slice(0, insertAt), marker, ...tagged.slice(insertAt)],
		truncationId,
		messagesRemoved: excluded.size,
		newContextTokens: remaining,
	}
}
