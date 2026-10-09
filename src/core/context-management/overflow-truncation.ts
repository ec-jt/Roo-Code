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
	if (latest === undefined || firstRemovable === undefined || firstRemovable === latest)
		return unchanged("No earlier complete exchange can be excluded safely.")
	// Retain the root/summary exchange, plus the latest user turn and tool chain.
	const cuts = boundaries
	const count = async (message: ApiMessage) =>
		apiHandler.countTokens(
			typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
		)
	const costs: number[] = []
	for (const message of visible) costs.push(await count(message))
	const overhead = await apiHandler.countTokens([
		{ type: "text", text: systemPrompt },
		...(tools ? [{ type: "text" as const, text: JSON.stringify(tools) }] : []),
	])
	const reserve = maxTokens && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 8192
	const inputLimit = contextWindow - reserve
	if (
		!Number.isFinite(inputLimit) ||
		inputLimit <= 0 ||
		costs.some((n) => !Number.isFinite(n) || n < 0) ||
		!Number.isFinite(overhead)
	)
		return unchanged("Cannot establish a safe post-overflow input size.")
	const truncationId = crypto.randomUUID()
	// Estimate the final marker too. It is added after the retained root/current summary.
	const markerText =
		"[Earlier complete exchanges excluded after overflow compaction failed. Original history remains stored.]"
	const markerTokens = await apiHandler.countTokens([{ type: "text", text: markerText }])
	const protectedTokens =
		overhead +
		costs.slice(0, firstRemovable).reduce((a, b) => a + b, 0) +
		costs.slice(latest).reduce((a, b) => a + b, 0) +
		markerTokens
	if (!Number.isFinite(markerTokens) || markerTokens < 0 || protectedTokens >= inputLimit)
		return unchanged(
			"The protected task and newest input are too large. Shorten the input or use a larger-context model.",
		)
	const target = Math.min(inputLimit, contextWindow * 0.75)
	let cut: number | undefined
	let remaining = overhead + costs.reduce((a, b) => a + b, 0) + markerTokens
	let prior = firstRemovable
	for (const boundary of cuts.slice(1)) {
		for (let i = prior; i < boundary; i++) remaining -= costs[i]
		prior = boundary
		cut = boundary
		if (remaining <= target) break
	}
	if (cut === undefined || cut <= firstRemovable)
		return unchanged("No complete earlier exchange can be excluded while preserving the task and latest input.")
	const excluded = new Set(visible.slice(firstRemovable, cut))
	const firstRetained = visible[cut]
	const insertAt = messages.indexOf(firstRetained)
	const tagged = messages.map((message) =>
		excluded.has(message) ? { ...message, truncationParent: truncationId } : message,
	)
	const marker: ApiMessage = {
		role: "user",
		content: markerText,
		isTruncationMarker: true,
		truncationId,
		ts: (firstRetained.ts ?? Date.now()) - 1,
	}
	return {
		messages: [...tagged.slice(0, insertAt), marker, ...tagged.slice(insertAt)],
		truncationId,
		messagesRemoved: excluded.size,
		newContextTokens: remaining,
	}
}
