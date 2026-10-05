import type { AssistantMessageContent } from "../assistant-message/types"
import { NativeToolCallParser } from "../assistant-message/NativeToolCallParser"
import type { ApiStreamToolCallChunk } from "../../api/transform/stream"

/** Replace a display-only partial with authoritative arguments exactly once. */
export function finalizeNativeToolCall(
	content: AssistantMessageContent[],
	indices: Map<string, number>,
	id: string,
	complete?: ApiStreamToolCallChunk,
): boolean {
	const index = content.findIndex(
		(block) => (block.type === "tool_use" || block.type === "mcp_tool_use") && block.id === id,
	)
	const existing = index >= 0 ? content[index] : undefined
	if (existing && !existing.partial) {
		NativeToolCallParser.discardToolCall(id)
		indices.delete(id)
		return false
	}
	const final = complete
		? NativeToolCallParser.parseToolCallOrError(complete)
		: NativeToolCallParser.finalizeStreamingToolCall(id)
	NativeToolCallParser.discardToolCall(id)
	indices.delete(id)
	if (!final && (!existing || existing.type !== "tool_use")) return false
	// Missing tracking must not promote previously parsed partial arguments to executable ones.
	const block = final ?? {
		...existing!,
		nativeArgs: undefined,
		argumentError: "Tool argument stream could not be finalized. Resend the complete arguments object.",
		partial: false,
	}
	if (index >= 0) content[index] = { ...block, id } as AssistantMessageContent
	else content.push({ ...block, id } as AssistantMessageContent)
	return true
}
