import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence/apiMessages"

/** Prefix of the marker inserted in place of a pruned tool-result middle. Used for idempotence. */
export const PRUNE_MARKER_PREFIX = "[... tool result middle pruned"

export const DEFAULT_PRUNE_THRESHOLD_CHARS = 8192
export const DEFAULT_PRUNE_HEAD_CHARS = 4096
export const DEFAULT_PRUNE_TAIL_CHARS = 1024

/** Upper bound for the marker length, including the artifact id and separators. */
const MARKER_RESERVE_CHARS = 160

export interface PruneToolResultsOptions {
	thresholdChars: number
	headChars: number
	tailChars: number
	/** Persists the full original text and returns the artifact id, or undefined on failure. */
	save: (text: string) => Promise<string | undefined>
}

export interface PruneToolResultsResult {
	messages: ApiMessage[]
	prunedCount: number
	savedChars: number
}

export function pruneMarker(artifactId: string): string {
	return `${PRUNE_MARKER_PREFIX}; full output: read_command_output artifact_id "${artifactId}" ...]`
}

type ToolResultBlock = Anthropic.Messages.ToolResultBlockParam
type ToolResultContentBlock = Exclude<ToolResultBlock["content"], string | undefined>[number]

function toolResultText(block: ToolResultBlock): string {
	if (typeof block.content === "string") return block.content
	if (!Array.isArray(block.content)) return ""
	return block.content
		.filter((part): part is Anthropic.Messages.TextBlockParam => part.type === "text")
		.map((part) => part.text)
		.join("\n")
}

function withText(block: ToolResultBlock, text: string): ToolResultBlock {
	if (typeof block.content === "string" || !Array.isArray(block.content)) {
		return { ...block, content: text }
	}
	// Replace the text parts with one combined text part at the position of the first one.
	// Images and other parts keep their order.
	const content: ToolResultContentBlock[] = []
	let inserted = false
	for (const part of block.content) {
		if (part.type === "text") {
			if (!inserted) {
				content.push({ ...part, text })
				inserted = true
			}
		} else {
			content.push(part)
		}
	}
	return { ...block, content }
}

/**
 * Keeps the head and tail of large tool results in messages before `preserveFrom` and saves
 * the full text as a task artifact. Lengths are measured in Unicode code points.
 * Returns new message objects; the input is not mutated.
 */
export async function pruneToolResults(
	messages: ApiMessage[],
	preserveFrom: number,
	opts: PruneToolResultsOptions,
): Promise<PruneToolResultsResult> {
	const { thresholdChars, headChars, tailChars, save } = opts
	if (headChars < 0 || tailChars < 0 || headChars + tailChars + MARKER_RESERVE_CHARS > thresholdChars) {
		throw new Error(
			`Invalid pruning budget: head (${headChars}) + marker (${MARKER_RESERVE_CHARS}) + tail (${tailChars}) must not exceed threshold (${thresholdChars})`,
		)
	}

	let prunedCount = 0
	let savedChars = 0
	const result: ApiMessage[] = []

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (index >= preserveFrom || !Array.isArray(message.content)) {
			result.push(message)
			continue
		}

		let changed = false
		const content: typeof message.content = []
		for (const block of message.content) {
			if (block.type !== "tool_result") {
				content.push(block)
				continue
			}
			const text = toolResultText(block)
			if (text.includes(PRUNE_MARKER_PREFIX)) {
				content.push(block)
				continue
			}
			const codePoints = Array.from(text)
			if (codePoints.length <= thresholdChars) {
				content.push(block)
				continue
			}

			let artifactId: string | undefined
			try {
				artifactId = await save(text)
			} catch {
				artifactId = undefined
			}
			if (!artifactId) {
				content.push(block)
				continue
			}

			const head = codePoints.slice(0, headChars).join("")
			const tail = tailChars > 0 ? codePoints.slice(-tailChars).join("") : ""
			const replacement = `${head}\n\n${pruneMarker(artifactId)}\n\n${tail}`
			content.push(withText(block, replacement))
			prunedCount++
			savedChars += codePoints.length - Array.from(replacement).length
			changed = true
		}

		result.push(changed ? { ...message, content } : message)
	}

	return { messages: result, prunedCount, savedChars }
}
