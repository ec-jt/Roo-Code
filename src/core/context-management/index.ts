import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { truncateAfterOverflow } from "./overflow-truncation"

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	const truncationId = crypto.randomUUID()

	// Filter to only visible messages (those not already truncated)
	// We need to track original indices to correctly tag messages in the full array
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	// Calculate how many visible messages to truncate (excluding first visible message)
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	if (messagesToRemove <= 0) {
		// Nothing to truncate
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	// Get the indices of visible messages to truncate (skip first visible, take next N)
	const indicesToTruncate = new Set(visibleIndices.slice(1, messagesToRemove + 1))

	// Tag messages that are being "truncated" (hidden from API calls)
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Find the actual boundary - the index right after the last truncated message
	const lastTruncatedVisibleIndex = visibleIndices[messagesToRemove] // Last visible message being truncated
	// If all visible messages except the first are truncated, insert marker at the end
	const firstKeptVisibleIndex = visibleIndices[messagesToRemove + 1] ?? taggedMessages.length

	// Insert truncation marker at the actual boundary (between last truncated and first kept)
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	// Insert marker at the boundary position
	// Find where to insert: right before the first kept visible message
	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return {
		messages: result,
		truncationId,
		messagesRemoved: messagesToRemove,
	}
}

/** Legacy estimates and thresholds are accepted for source/import compatibility only. */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent?: number
	profileThresholds?: Record<string, number>
	currentProfileId?: string
	lastMessageTokens: number
	/** Set only after an explicit provider context-limit rejection. */
	contextLimitExceeded?: boolean
}

export function willManageContext(options: WillManageContextOptions): boolean {
	return options.autoCondenseContext && options.contextLimitExceeded === true
}

export type ContextManagementOptions = Omit<WillManageContextOptions, "lastMessageTokens"> & {
	messages: ApiMessage[]
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	fallbackReason?: "context-limit" | "empty-summary"
}

/** Summarize only on explicit overflow; truncate only for an eligible summary failure. */
export async function manageContext(options: ContextManagementOptions): Promise<ContextManagementResult> {
	const { messages, totalTokens: prevContextTokens } = options
	const unchanged = { messages, summary: "", cost: 0, prevContextTokens }
	if (!willManageContext({ ...options, lastMessageTokens: 0 })) return unchanged

	// Preserve the latest input verbatim. Keep its tool-call exchange too, so no
	// tool result loses its matching assistant call when the prefix is summarized.
	let preserveFrom = messages.length - 1
	while (preserveFrom > 0 && messages[preserveFrom - 1].role === "user") preserveFrom--
	const latestInput = messages.slice(preserveFrom)
	const hasToolResults = latestInput.some(
		(message) => Array.isArray(message.content) && message.content.some((block) => block.type === "tool_result"),
	)
	if (hasToolResults && preserveFrom > 0) preserveFrom--
	if (preserveFrom < 2)
		return { ...unchanged, error: "Not enough earlier history to compact. Use manual context management." }

	const result = await summarizeConversation({
		messages: structuredClone(messages.slice(0, preserveFrom)),
		apiHandler: options.apiHandler,
		systemPrompt: options.systemPrompt,
		taskId: options.taskId,
		isAutomaticTrigger: true,
		customCondensingPrompt: options.customCondensingPrompt,
		metadata: options.metadata,
		environmentDetails: options.environmentDetails,
		filesReadByRoo: options.filesReadByRoo,
		cwd: options.cwd,
		rooIgnoreController: options.rooIgnoreController,
	})
	if (result.failureKind) {
		const fallback = await truncateAfterOverflow({ ...options, tools: options.metadata?.tools })
		return { ...unchanged, ...fallback, cost: result.cost, fallbackReason: result.failureKind }
	}
	if (result.error || !result.summary)
		return {
			...unchanged,
			cost: result.cost,
			error: result.error || "Context compaction produced no summary.",
			errorDetails: result.errorDetails,
		}
	const retained = messages.slice(preserveFrom)
	const retainedTokens = await estimateTokenCount(
		retained.flatMap((message) =>
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
		),
		options.apiHandler,
	)
	return {
		...result,
		messages: [...result.messages, ...retained],
		prevContextTokens,
		newContextTokens: (result.newContextTokens ?? 0) + retainedTokens,
	}
}
