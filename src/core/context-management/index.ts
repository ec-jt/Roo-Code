import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { getEffectiveApiHistory, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { RooIgnoreController } from "../ignore/RooIgnoreController"
import { truncateAfterOverflow } from "./overflow-truncation"
import {
	DEFAULT_PRUNE_HEAD_CHARS,
	DEFAULT_PRUNE_TAIL_CHARS,
	DEFAULT_PRUNE_THRESHOLD_CHARS,
	pruneToolResults,
} from "./prune-tool-results"
import { offloadImages, type SaveImage } from "./offload-images"

/** Fraction of the input budget kept free when deciding whether pruning alone is enough. */
const PRUNE_SAFETY_MARGIN = 0.1

function messageContentBlocks(messages: ApiMessage[]): Array<Anthropic.Messages.ContentBlockParam> {
	return messages.flatMap((message) =>
		typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
	)
}

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
	allowOverflowTruncation?: boolean
	signal?: AbortSignal
	apiHandler: ApiHandler
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	metadata?: ApiHandlerCreateMessageMetadata
	environmentDetails?: string
	filesReadByRoo?: string[]
	cwd?: string
	rooIgnoreController?: RooIgnoreController
	/** Deterministic task-state recall, when the task has an enabled ledger. */
	taskStateRecall?: string
	/** Architecture context (cited records) passed to the summary request. */
	architectureContext?: string
	/** Prune large old tool results before summarizing. Default true; needs `saveArtifact`. */
	pruneToolResults?: boolean
	/** Saves full tool-result text as a task artifact and returns its id. */
	saveArtifact?: (text: string) => Promise<string | undefined>
	/** Offload old images to files before summarizing. Default true; needs `saveImage` and an image model. */
	offloadImages?: boolean
	/** Saves image data in the task folder and returns its absolute path. */
	saveImage?: SaveImage
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	fallbackReason?: "context-limit" | "empty-summary"
	/** Set when pruning alone brought the request under the budget. */
	pruneId?: string
	/** Tool results shortened and images offloaded. Also set when a summary or truncation followed. */
	prunedCount?: number
	offloadedCount?: number
}

function stillTooLargeError(tokens: number | undefined, inputLimit: number, contextWindow: number): string {
	return (
		`Context is still too large after automatic recovery (about ${tokens ?? "unknown"} tokens; ` +
		`the limit is ${inputLimit} for a ${contextWindow}-token window). History was not changed. ` +
		"Use a larger-context model or start a new task with a reviewed handoff."
	)
}

/**
 * Overflow recovery when there is no earlier history to summarize, for example when the
 * first large tool batch overflows: `[task prompt, assistant tool calls, user tool results]`.
 * Shortens tool results (head and tail kept, full text saved) and offloads images in the
 * whole history, including the latest input. Tool calls and results stay paired because
 * only the result text changes. Runs only inside overflow recovery (C-6).
 */
async function reduceWithoutSummary(
	options: ContextManagementOptions,
	unchanged: ContextManagementResult,
): Promise<ContextManagementResult> {
	const { messages } = options
	const inputLimit = options.contextWindow - (options.maxTokens ?? 0)
	const countAll = async (history: ApiMessage[]) => {
		try {
			return await options.apiHandler.countTokens([
				{ type: "text", text: options.systemPrompt },
				...messageContentBlocks(history),
			])
		} catch {
			return undefined
		}
	}
	let working = messages
	let prunedCount = 0
	let offloadedCount = 0
	if (options.pruneToolResults !== false && options.saveArtifact) {
		const pruned = await pruneToolResults(working, working.length, {
			thresholdChars: DEFAULT_PRUNE_THRESHOLD_CHARS,
			headChars: DEFAULT_PRUNE_HEAD_CHARS,
			tailChars: DEFAULT_PRUNE_TAIL_CHARS,
			save: options.saveArtifact,
		})
		working = pruned.messages
		prunedCount = pruned.prunedCount
	}
	if (options.offloadImages !== false && options.saveImage && options.apiHandler.getModel().info.supportsImages) {
		const offloaded = await offloadImages(working, working.length, options.saveImage)
		working = offloaded.messages
		offloadedCount = offloaded.offloadedCount
	}
	const estimate = await countAll(working)
	if (prunedCount + offloadedCount === 0)
		return { ...unchanged, error: stillTooLargeError(estimate, inputLimit, options.contextWindow) }
	// Compare with the input limit, not the 0.9 summary budget: no summary can follow here,
	// so a stricter margin would only refuse requests that fit. The provider stays the final
	// judge, and a second rejection stops after the single retry. When the count fails, the
	// reduced history is still sent once for the same reason.
	if (estimate !== undefined && Number.isFinite(inputLimit) && inputLimit > 0 && estimate > inputLimit)
		return { ...unchanged, error: stillTooLargeError(estimate, inputLimit, options.contextWindow) }
	const before = await countAll(messages)
	return {
		messages: working,
		summary: "",
		cost: 0,
		prevContextTokens: Math.max(unchanged.prevContextTokens, before ?? 0),
		...(estimate !== undefined ? { newContextTokens: estimate } : {}),
		pruneId: crypto.randomUUID(),
		prunedCount,
		...(offloadedCount ? { offloadedCount } : {}),
	}
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
	// Too little earlier history to summarize: shorten the latest input instead (D1, 4.2.91).
	if (preserveFrom < 2) return reduceWithoutSummary(options, unchanged)

	// Step 1: prune large old tool results. Step 2: offload old images to files.
	// If that is enough, skip the summary.
	let working = messages
	let prunedCount = 0
	let offloadedCount = 0
	if (options.pruneToolResults !== false && options.saveArtifact) {
		const pruned = await pruneToolResults(working, preserveFrom, {
			thresholdChars: DEFAULT_PRUNE_THRESHOLD_CHARS,
			headChars: DEFAULT_PRUNE_HEAD_CHARS,
			tailChars: DEFAULT_PRUNE_TAIL_CHARS,
			save: options.saveArtifact,
		})
		working = pruned.messages
		prunedCount = pruned.prunedCount
	}
	// Models without image support already drop images in the summary request.
	if (options.offloadImages !== false && options.saveImage && options.apiHandler.getModel().info.supportsImages) {
		const offloaded = await offloadImages(working, preserveFrom, options.saveImage)
		working = offloaded.messages
		offloadedCount = offloaded.offloadedCount
	}
	if (prunedCount + offloadedCount > 0) {
		try {
			const estimate = await options.apiHandler.countTokens([
				{ type: "text", text: options.systemPrompt },
				...messageContentBlocks(working),
			])
			const budget = (options.contextWindow - (options.maxTokens ?? 0)) * (1 - PRUNE_SAFETY_MARGIN)
			if (estimate <= budget) {
				return {
					messages: working,
					summary: "",
					cost: 0,
					prevContextTokens,
					newContextTokens: estimate,
					pruneId: crypto.randomUUID(),
					prunedCount,
					offloadedCount,
				}
			}
		} catch {
			// Estimation failed: continue with summarizing the reduced history.
		}
	}

	// Report prune/offload counts even when a summary or truncation still follows.
	const reduced = {
		...(prunedCount ? { prunedCount } : {}),
		...(offloadedCount ? { offloadedCount } : {}),
	}
	const result = await summarizeConversation({
		messages: structuredClone(working.slice(0, preserveFrom)),
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
		signal: options.signal,
		taskStateRecall: options.taskStateRecall,
		architectureContext: options.architectureContext,
	})
	if (result.failureKind) {
		if (options.allowOverflowTruncation === false) {
			return {
				...unchanged,
				cost: result.cost,
				error: `${result.error || "Context compaction failed."} Automatic truncation fallback is disabled in Settings > Context Management.`,
				errorDetails: result.errorDetails,
			}
		}
		const fallback = await truncateAfterOverflow({ ...options, messages: working, tools: options.metadata?.tools })
		if (fallback.error) {
			return {
				...unchanged,
				cost: result.cost,
				error: `${result.error || "Context compaction failed."}\n\nTruncation fallback could not be applied. History was not changed. ${fallback.error}`,
				errorDetails: result.errorDetails,
				fallbackReason: result.failureKind,
			}
		}
		return {
			...unchanged,
			...fallback,
			cost: result.cost,
			fallbackReason: result.failureKind,
			...reduced,
		}
	}
	if (result.error || !result.summary)
		return {
			...unchanged,
			cost: result.cost,
			error: result.error || "Context compaction produced no summary.",
			errorDetails: result.errorDetails,
		}
	// Step 3 (only when the summary is not enough): the kept tail holds the newest tool
	// exchange verbatim. A huge newest result (for example a 6,800-line read) can keep the
	// prompt over the window, or make it larger than before. Shorten the tail's tool results
	// too (head and tail kept, full text saved), then offload its images. Fixed sequence; no loop.
	let retained = working.slice(preserveFrom)
	const summaryTokens = result.newContextTokens ?? 0
	let newContextTokens =
		summaryTokens + (await estimateTokenCount(messageContentBlocks(retained), options.apiHandler))
	const inputLimit = options.contextWindow - (options.maxTokens ?? 0)
	const budget = inputLimit * (1 - PRUNE_SAFETY_MARGIN)
	let tailPruned = 0
	let tailOffloaded = 0
	if (newContextTokens > budget) {
		if (options.pruneToolResults !== false && options.saveArtifact) {
			const pruned = await pruneToolResults(retained, retained.length, {
				thresholdChars: DEFAULT_PRUNE_THRESHOLD_CHARS,
				headChars: DEFAULT_PRUNE_HEAD_CHARS,
				tailChars: DEFAULT_PRUNE_TAIL_CHARS,
				save: options.saveArtifact,
			})
			retained = pruned.messages
			tailPruned = pruned.prunedCount
		}
		if (options.offloadImages !== false && options.saveImage && options.apiHandler.getModel().info.supportsImages) {
			const offloaded = await offloadImages(retained, retained.length, options.saveImage)
			retained = offloaded.messages
			tailOffloaded = offloaded.offloadedCount
		}
		if (tailPruned + tailOffloaded > 0)
			newContextTokens =
				summaryTokens + (await estimateTokenCount(messageContentBlocks(retained), options.apiHandler))
		// Truncation cannot help here: after a summary it protects the summary and the newest
		// tool interaction, which is all that remains. Do not send a prompt known to overflow.
		if (Number.isFinite(inputLimit) && inputLimit > 0 && newContextTokens > inputLimit) {
			return {
				...unchanged,
				cost: result.cost,
				error: stillTooLargeError(newContextTokens, inputLimit, options.contextWindow),
			}
		}
	}
	const allPruned = prunedCount + tailPruned
	const allOffloaded = offloadedCount + tailOffloaded
	// Report the true pre-recovery size. The caller's value is the last request's usage,
	// which does not include tool results added since then.
	let truePrev = prevContextTokens
	try {
		const tools = options.metadata?.tools?.length
			? [{ type: "text" as const, text: JSON.stringify(options.metadata.tools) }]
			: []
		const before = await options.apiHandler.countTokens([
			{ type: "text", text: options.systemPrompt },
			...messageContentBlocks(getEffectiveApiHistory(messages)),
			...tools,
		])
		if (Number.isFinite(before) && before > truePrev) truePrev = before
	} catch {
		// Keep the caller's value.
	}
	return {
		...result,
		messages: [...result.messages, ...retained],
		prevContextTokens: truePrev,
		newContextTokens,
		...(allPruned ? { prunedCount: allPruned } : {}),
		...(allOffloaded ? { offloadedCount: allOffloaded } : {}),
	}
}
