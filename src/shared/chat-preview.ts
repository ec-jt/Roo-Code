import type { ChatWindowState, ClineMessage } from "@roo-code/types"

export function isChatPreview(message: ClineMessage, window?: Pick<ChatWindowState, "truncatedTs">): boolean {
	return message.chatPreview?.truncated ?? window?.truncatedTs.includes(message.ts) ?? false
}

export function isEmptyCommandStatus(message: ClineMessage): boolean {
	return (
		(message.ask === "command_output" || message.say === "command_output") &&
		!message.text?.trim() &&
		!message.reasoning?.trim() &&
		!message.images?.length &&
		!message.chatPreview?.hasContent
	)
}

/** Read only a bounded string prefix; never parse a truncated tool object as JSON. */
export function chatPreviewLabel(message: ClineMessage): string {
	if (message.chatPreview?.label) return message.chatPreview.label
	const kind = message.ask ?? message.say ?? message.type
	const prefix = message.text?.slice(0, 1024) ?? ""
	if (kind === "tool" || kind === "use_mcp_server") {
		const tool = prefix.match(/"(?:tool|toolName)"\s*:\s*"([a-zA-Z0-9_.:-]{1,80})"/)
		if (tool) return tool[1]
		return kind === "tool" ? "Tool details" : "MCP request"
	}
	if (kind === "command_output") return "Command output"
	if (kind === "command") return `Command: ${prefix.split("\n", 1)[0].slice(0, 100)}`
	return kind.replaceAll("_", " ")
}
