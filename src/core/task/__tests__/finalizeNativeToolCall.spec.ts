import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { AssistantMessageContent } from "../../assistant-message/types"
import { finalizeNativeToolCall } from "../finalizeNativeToolCall"

describe("finalizeNativeToolCall", () => {
	let content: AssistantMessageContent[]
	let indices: Map<string, number>
	beforeEach(() => {
		content = []
		indices = new Map()
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	function partial(id: string, args: string, index = 0, name = "file_system") {
		for (const event of NativeToolCallParser.processRawChunk({ id, name, index, arguments: args })) {
			if (event.type === "tool_call_start") NativeToolCallParser.startStreamingToolCall(id, name)
			if (event.type === "tool_call_delta") {
				const block = NativeToolCallParser.processStreamingChunk(id, event.delta)!
				indices.set(id, content.length)
				content.push({ ...block, id })
			}
		}
	}

	const complete = (id: string, args = '{"action":"read_text_file","path":"safe.ts"}') => ({
		type: "tool_call" as const,
		id,
		name: "file_system",
		arguments: args,
	})

	it("replaces truncated partial arguments with completion once and clears pending parser state", () => {
		partial("a", '{"action":"read_text_file","path":"wrong')
		expect(finalizeNativeToolCall(content, indices, "a", complete("a"))).toBe(true)
		expect(content).toHaveLength(1)
		expect(content[0]).toMatchObject({ id: "a", partial: false, nativeArgs: { path: "safe.ts" } })
		expect(indices.size).toBe(0)
		expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
		expect(NativeToolCallParser.finalizeRawChunks()).toEqual([])
		expect(finalizeNativeToolCall(content, indices, "a", complete("a"))).toBe(false)
		expect(finalizeNativeToolCall(content, indices, "a")).toBe(false)
		expect(content).toHaveLength(1)
	})

	it("preserves call order when parallel completions arrive in reverse order", () => {
		partial("a", '{"action":"read_text_file","path":"a.ts"}', 0)
		partial("b", '{"action":"read_text_file","path":"b.ts"}', 1)
		finalizeNativeToolCall(content, indices, "b", complete("b"))
		finalizeNativeToolCall(content, indices, "a")
		expect(content.map((block) => block.type === "tool_use" && block.id)).toEqual(["a", "b"])
		expect(content.every((block) => !block.partial)).toBe(true)
	})

	it("keeps malformed complete calls as one non-executable error block", () => {
		finalizeNativeToolCall(content, indices, "a", complete("a", '{"action":'))
		expect(content).toHaveLength(1)
		expect(content[0]).toMatchObject({ id: "a", partial: false, argumentError: expect.any(String) })
		expect(content[0]).not.toHaveProperty("nativeArgs", expect.anything())
	})

	it.each([false, true])("never promotes partial executable arguments on failure (missing tracking: %s)", (lost) => {
		partial("a", '{"command":"echo partial"', 0, "execute_command")
		expect(content[0]).toMatchObject({ nativeArgs: { command: "echo partial" } })
		if (lost) NativeToolCallParser.discardToolCall("a")
		expect(finalizeNativeToolCall(content, indices, "a")).toBe(true)
		expect(content[0]).toMatchObject({ partial: false, argumentError: expect.any(String) })
		expect(content[0]).not.toHaveProperty("nativeArgs", expect.anything())
	})

	it("finalizes a complete MCP payload in place", () => {
		content.push({ type: "tool_use", id: "m", name: "use_mcp_tool", params: {}, partial: true })
		indices.set("m", 0)
		finalizeNativeToolCall(content, indices, "m", {
			type: "tool_call",
			id: "m",
			name: "mcp--server--lookup",
			arguments: '{"query":"test"}',
		})
		expect(content).toHaveLength(1)
		expect(content[0]).toMatchObject({ type: "mcp_tool_use", id: "m", partial: false })
	})
})
