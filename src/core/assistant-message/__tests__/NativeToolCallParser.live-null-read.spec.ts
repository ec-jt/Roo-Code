import { NativeToolCallParser } from "../NativeToolCallParser"
import type { AssistantMessageContent } from "../types"
import { finalizeNativeToolCall } from "../../task/finalizeNativeToolCall"
import type { ToolUse } from "../../../shared/tools"

/**
 * D-M1a (4.2.87 live task 01a1f60e): DeepSeek's task_state read was stored in API history as
 * {"action":"read","operations":"null"} and failed 3 times with the generic schema error.
 * That stored input was rebuilt from lossy string params (unknown keys such as expected_revision
 * dropped, null turned into "null"), so it was not the raw call. A raw read that carries any
 * non-null expected_revision produces exactly that stored input and was rejected by the
 * read refinement. These tests replay the call through the same streaming path the
 * OpenAI-compatible DeepSeek handler uses (tool_call_partial -> processRawChunk -> finalize).
 */
const LIVE_STORED_INPUT = { action: "read", operations: "null" }

function streamCall(id: string, name: string, args: string) {
	const content: AssistantMessageContent[] = []
	const indices = new Map<string, number>()
	// DeepSeek streams the name first, then argument fragments.
	const chunks = [{ index: 0, id, name, arguments: "" }]
	for (let i = 0; i < args.length; i += 7)
		chunks.push({ index: 0, id: "", name: "", arguments: args.slice(i, i + 7) })
	for (const chunk of chunks) {
		for (const event of NativeToolCallParser.processRawChunk({
			index: chunk.index,
			id: chunk.id || undefined,
			name: chunk.name || undefined,
			arguments: chunk.arguments || undefined,
		})) {
			if (event.type === "tool_call_start") {
				NativeToolCallParser.startStreamingToolCall(event.id, event.name)
				indices.set(event.id, content.length)
				content.push({
					type: "tool_use",
					name: event.name as any,
					params: {},
					partial: true,
					id: event.id,
				} as any)
			} else if (event.type === "tool_call_delta") {
				const partial = NativeToolCallParser.processStreamingChunk(event.id, event.delta)
				const at = indices.get(event.id)
				if (partial && at !== undefined) content[at] = { ...partial, id: event.id } as AssistantMessageContent
			}
		}
	}
	for (const event of NativeToolCallParser.processFinishReason("tool_calls"))
		finalizeNativeToolCall(content, indices, event.id)
	return content[0] as ToolUse
}

/** Same reduction Task.ts uses to build the stored tool_use.input. */
const historyInput = (block: ToolUse) =>
	Object.fromEntries(
		Object.entries(
			block.nativeArgs || (block.argumentError !== undefined ? block.rawInput : undefined) || block.params,
		).filter(([, value]) => value !== undefined),
	)
const legacyHistoryInput = (block: ToolUse) =>
	Object.fromEntries(Object.entries(block.nativeArgs || block.params).filter(([, value]) => value !== undefined))

describe("D-M1a live DeepSeek task_state read replay", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	it.each([
		'{"action":"read","operations":"null"}',
		'{"action": "read", "operations": "null"}',
		'{"action":"read","expected_revision":"<revision from read>","operations":null}',
		'{"action":"read","expected_revision":"none","operations":"null"}',
		`{"action":"read","expected_revision":"${"a".repeat(64)}","operations":null}`,
		'{"action":"read","expected_revision":"null","operations":"[]"}',
	])("accepts the streamed read %s as a plain read", (raw) => {
		const block = streamCall("call_00_uM4BrXGZApbzKM17a5kh7600", "task_state", raw)
		expect(block.argumentError).toBeUndefined()
		expect(block.partial).toBe(false)
		expect(block.nativeArgs).toEqual({ action: "read", expected_revision: null, operations: null })
	})

	it("explains the live stored input: a rejected read with a revision is stored lossily", () => {
		// A raw call that the parser rejects keeps only toolParamNames in params, with null stringified.
		const rejected = NativeToolCallParser.parseToolCallOrError({
			id: "x",
			name: "task_state",
			arguments: '{"action":"read","expected_revision":"none","operations":null,"extra":1}',
		}) as ToolUse
		expect(rejected.argumentError).toContain("schema at (arguments): Unrecognized key")
		// Before 4.2.88 history used params, which reproduces the live stored input exactly.
		expect(legacyHistoryInput(rejected)).toEqual(LIVE_STORED_INPUT)
		// Now history keeps the exact object the model sent.
		expect(historyInput(rejected)).toEqual({
			action: "read",
			expected_revision: "none",
			operations: null,
			extra: 1,
		})
	})
})
