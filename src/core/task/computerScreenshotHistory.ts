import type { Anthropic } from "@anthropic-ai/sdk"

/** How many of the latest computer_action screenshots stay in model history. */
export const KEEP_RECENT_COMPUTER_SCREENSHOTS = 3

type HistoryMessage = Anthropic.MessageParam

/**
 * User messages that answer a computer_action tool call and still contain images,
 * oldest first. Only images in those messages are candidates for compaction, so
 * images the user pasted, or images from other tools, are never removed.
 */
export function findComputerScreenshotMessages<T extends HistoryMessage>(history: T[]): T[] {
	const found: T[] = []
	let previousAssistantUsedComputer = false

	for (const message of history) {
		if (message.role === "assistant") {
			previousAssistantUsedComputer =
				Array.isArray(message.content) &&
				message.content.some(
					(block) =>
						block.type === "tool_use" && (block as Anthropic.ToolUseBlock).name === "computer_action",
				)
			continue
		}
		if (
			previousAssistantUsedComputer &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "image")
		) {
			found.push(message)
		}
	}
	return found
}
