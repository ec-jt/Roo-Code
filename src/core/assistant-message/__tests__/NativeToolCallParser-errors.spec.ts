import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser safe failures", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	const parse = (args: unknown) =>
		NativeToolCallParser.parseToolCallOrError({
			id: "call",
			name: "file_system",
			arguments: JSON.stringify(args),
		})

	it("accepts the reported string-null optional payload without changing search strings", () => {
		const result = parse({
			action: "list_directory",
			path: ".",
			regex: "null",
			file_pattern: "null",
			recursive: "null",
		})
		expect(result).toMatchObject({
			id: "call",
			partial: false,
			nativeArgs: {
				action: "list_directory",
				path: ".",
				regex: "null",
				file_pattern: "null",
				recursive: undefined,
			},
		})
		expect(result).not.toHaveProperty("argumentError")
	})

	it("normalizes actual null optionals to undefined", () => {
		expect(
			parse({ action: "read_text_file", path: "README.md", regex: null, file_pattern: null, recursive: null }),
		).toMatchObject({ nativeArgs: { regex: undefined, file_pattern: undefined, recursive: undefined } })
	})

	it.each([true, false])("preserves recursive boolean %s", (recursive) => {
		expect(parse({ action: "list_directory", path: ".", recursive })).toMatchObject({ nativeArgs: { recursive } })
	})

	it("preserves literal null as a search expression and file pattern", () => {
		expect(parse({ action: "search_files", path: ".", regex: "null", file_pattern: "null" })).toMatchObject({
			nativeArgs: { regex: "null", file_pattern: "null" },
		})
	})

	it.each([
		[{ action: "delete", path: "." }, "file_system.action"],
		[{ action: "read_text_file", path: null }, "file_system.path"],
		[{ action: "read_text_file", path: " " }, "file_system.path"],
		[{ action: "read_text_file", path: 42 }, "file_system.path"],
		[{ action: "search_files", path: ".", regex: null }, "file_system.regex"],
		[{ action: "search_files", path: ".", regex: 3 }, "file_system.regex"],
		[{ action: "search_files", path: ".", regex: "x", file_pattern: [] }, "file_system.file_pattern"],
		...["false", "true", "NULL", "garbage", 1, {}].map((recursive): [unknown, string] => [
			{ action: "list_directory", path: ".", recursive },
			"file_system.recursive",
		]),
	])("returns specific non-executable diagnostics for %j", (args, message) => {
		expect(parse(args)).toMatchObject({
			type: "tool_use",
			id: "call",
			partial: false,
			nativeArgs: undefined,
			argumentError: expect.stringContaining(message as string),
		})
	})

	it.each([null, [], "text", false, 42])("rejects non-object root %j", (args) => {
		expect(parse(args)).toMatchObject({
			nativeArgs: undefined,
			argumentError: expect.stringContaining("JSON object"),
		})
	})

	it("retains the nullable API and excludes sensitive payloads from diagnostics", () => {
		const call = { id: "call", name: "execute_command" as const, arguments: '{"command":"SECRET"' }
		const error = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(NativeToolCallParser.parseToolCall(call)).toBeNull()
		expect(NativeToolCallParser.parseToolCallOrError(call)).toMatchObject({
			params: {},
			nativeArgs: undefined,
			argumentError: expect.not.stringContaining("SECRET"),
		})
		expect(error).not.toHaveBeenCalled()
		error.mockRestore()
	})

	it("does not retain executable partial args when final JSON is truncated", () => {
		NativeToolCallParser.startStreamingToolCall("call", "execute_command")
		expect(NativeToolCallParser.processStreamingChunk("call", '{"command":"echo unsafe"')).toMatchObject({
			partial: true,
			nativeArgs: { command: "echo unsafe" },
		})
		expect(NativeToolCallParser.finalizeStreamingToolCall("call")).toMatchObject({
			id: "call",
			params: {},
			partial: false,
			nativeArgs: undefined,
			argumentError: expect.any(String),
		})
		expect(NativeToolCallParser.finalizeStreamingToolCall("call")).toBeNull()
	})

	it("discards only the matching accumulator and all raw trackers for that ID", () => {
		for (const [index, id] of ["call", "call", "other"].entries()) {
			NativeToolCallParser.processRawChunk({ index, id, name: "read_file", arguments: '{"path":"ok"}' })
			NativeToolCallParser.startStreamingToolCall(id, "read_file")
			NativeToolCallParser.processStreamingChunk(id, '{"path":"ok"}')
		}
		NativeToolCallParser.discardToolCall("call")
		expect(NativeToolCallParser.processStreamingChunk("call", "}")).toBeNull()
		expect(NativeToolCallParser.finalizeStreamingToolCall("call")).toBeNull()
		expect(NativeToolCallParser.finalizeRawChunks()).toEqual([{ type: "tool_call_end", id: "other" }])
		expect(NativeToolCallParser.finalizeStreamingToolCall("other")).toMatchObject({ nativeArgs: { path: "ok" } })
	})

	it("also discards raw tracking on finalization", () => {
		NativeToolCallParser.processRawChunk({ index: 0, id: "call", name: "read_file" })
		NativeToolCallParser.startStreamingToolCall("call", "read_file")
		NativeToolCallParser.finalizeStreamingToolCall("call")
		expect(NativeToolCallParser.processFinishReason("tool_calls")).toEqual([])
	})

	it("rejects malformed dynamic MCP arguments without executable MCP blocks", () => {
		expect(
			NativeToolCallParser.parseToolCallOrError({ id: "mcp", name: "mcp--server--tool", arguments: "[]" }),
		).toMatchObject({ type: "tool_use", id: "mcp", nativeArgs: undefined, argumentError: expect.any(String) })
	})
})
