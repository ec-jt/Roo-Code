// cd src && npx vitest run api/providers/__tests__/openai-codex-native-tool-calls.spec.ts

import { OpenAiCodexHandler } from "../openai-codex"
import type { ApiStreamChunk } from "../../transform/stream"
import type { ApiHandlerOptions } from "../../../shared/api"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

describe("OpenAiCodexHandler native tool calls", () => {
	let handler: OpenAiCodexHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		vi.restoreAllMocks()
		NativeToolCallParser.clearRawChunkState()
		NativeToolCallParser.clearAllStreamingToolCalls()

		mockOptions = {
			apiModelId: "gpt-5.2-2025-12-11",
			// minimal settings; OAuth is mocked below
		}
		handler = new OpenAiCodexHandler(mockOptions)
	})

	it("yields tool_call_partial chunks when API returns function_call-only response", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		// Mock OpenAI SDK streaming (preferred path).
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.added",
							item: {
								type: "function_call",
								call_id: "call_1",
								name: "attempt_completion",
								arguments: "",
							},
							output_index: 0,
						}
						yield {
							type: "response.function_call_arguments.delta",
							delta: '{"result":"hi"}',
							// Note: intentionally omit call_id + name to simulate tool-call-only streams.
							item_id: "fc_1",
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_1",
								status: "completed",
								output: [
									{
										type: "function_call",
										call_id: "call_1",
										name: "attempt_completion",
										arguments: '{"result":"hi"}',
									},
								],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
			if (chunk.type === "tool_call_partial") {
				// Simulate Task.ts behavior so finish_reason handling can emit tool_call_end elsewhere
				NativeToolCallParser.processRawChunk({
					index: chunk.index,
					id: chunk.id,
					name: chunk.name,
					arguments: chunk.arguments,
				})
			}
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call_partial")
		expect(toolChunks.length).toBeGreaterThan(0)
		expect(toolChunks[0]).toMatchObject({
			type: "tool_call_partial",
			id: "call_1",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits assistant message only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.done",
							item: {
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "hello from spark" }],
							},
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "hello from spark" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("hello from spark")
	})

	it("yields text when Codex emits assistant message only in response.completed output", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.completed",
							response: {
								id: "resp_completed_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "final payload only" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("final payload only")
	})

	it("yields text when Codex emits response.output_text.done without deltas", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_text.done",
							text: "done-event text only",
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_text_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("done-event text only")
	})

	it("yields tool_call when Codex emits function_call only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.output_item.done",
							item: {
								type: "function_call",
								call_id: "call_done_only",
								name: "attempt_completion",
								arguments: '{"result":"ok"}',
							},
							output_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_done_tool_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const toolCalls = chunks.filter((c) => c.type === "tool_call")
		expect(toolCalls.length).toBeGreaterThan(0)
		expect(toolCalls[0]).toMatchObject({
			type: "tool_call",
			id: "call_done_only",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits response.content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "response.content_part.added",
							part: {
								type: "output_text",
								text: "content part text",
							},
							output_index: 0,
							content_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("content part text")
	})

	it("does not duplicate text when Codex emits delta and output_text.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield { type: "response.output_text.delta", delta: "hello " }
						yield { type: "response.output_text.delta", delta: "world" }
						yield { type: "response.output_text.done", text: "hello world" }
						yield {
							type: "response.completed",
							response: {
								id: "resp_delta_done",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	it("does not duplicate text when Codex emits delta and content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield { type: "response.output_text.delta", delta: "hello world" }
						yield {
							type: "response.content_part.added",
							part: { type: "output_text", text: "hello world" },
							output_index: 0,
							content_index: 0,
						}
						yield {
							type: "response.completed",
							response: {
								id: "resp_delta_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						}
					},
				}),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks: any[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
		}

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	async function collectEvents(events: unknown[]): Promise<ApiStreamChunk[]> {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue({
					async *[Symbol.asyncIterator]() {
						yield* events
					},
				}),
			},
		}
		const chunks: ApiStreamChunk[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "test" }])) {
			chunks.push(chunk)
		}
		return chunks
	}

	function added(callId: string, itemId: string, outputIndex?: number) {
		return {
			type: "response.output_item.added",
			output_index: outputIndex,
			item: { type: "function_call", id: itemId, call_id: callId, name: "file_system", arguments: "" },
		}
	}

	it.each(["item_id", "output_index", "call_id"])("keeps interleaved calls separate using %s", async (identity) => {
		const first = { item_id: "fc_a", output_index: 3, call_id: "call_a" }
		const second = { item_id: "fc_b", output_index: 7, call_id: "call_b" }
		const delta = (ids: typeof first, args: string) => ({
			type: "response.function_call_arguments.delta",
			[identity]: ids[identity as keyof typeof first],
			// output_index must take precedence over this legacy field.
			...(identity === "output_index" ? { index: 0 } : {}),
			delta: args,
		})
		const chunks = await collectEvents([
			added("call_a", "fc_a", 3),
			added("call_b", "fc_b", 7),
			delta(first, '{"action":"read_text_file",'),
			delta(second, '{"action":"list_directory",'),
			delta(first, '"path":"a.txt"}'),
			delta(second, '"path":"."}'),
		])
		const partials = chunks.filter((chunk) => chunk.type === "tool_call_partial")
		expect(partials.map((chunk) => [chunk.id, chunk.index])).toEqual([
			["call_a", 3],
			["call_b", 7],
			["call_a", 3],
			["call_b", 7],
		])
		const parserEvents = partials.flatMap((chunk) => NativeToolCallParser.processRawChunk(chunk))
		const argumentsById: Record<string, string> = {}
		for (const event of parserEvents) {
			if (event.type === "tool_call_delta") {
				argumentsById[event.id] = (argumentsById[event.id] ?? "") + event.delta
			}
		}
		expect(JSON.parse(argumentsById.call_a)).toEqual({ action: "read_text_file", path: "a.txt" })
		expect(JSON.parse(argumentsById.call_b)).toEqual({ action: "list_directory", path: "." })
		expect(NativeToolCallParser.finalizeRawChunks()).toEqual([
			{ type: "tool_call_end", id: "call_a" },
			{ type: "tool_call_end", id: "call_b" },
		])
		expect(chunks.some((chunk) => chunk.type === "tool_call")).toBe(false)
	})

	it.each(["function_call", "tool_call"])(
		"replaces truncated %s deltas with one authoritative completion",
		async (type) => {
			const args = '{"action":"read_text_file","path":"README.md"}'
			const done = {
				type: `response.${type}_arguments.done`,
				item_id: "fc_a",
				arguments: args,
			}
			const chunks = await collectEvents([
				added("call_a", "fc_a", 2),
				{ type: `response.${type}_arguments.delta`, item_id: "fc_a", delta: '{"action":"read_' },
				done,
				done,
				{ type: `response.${type}_arguments.delta`, item_id: "fc_a", delta: "ignored late delta" },
				{
					type: "response.output_item.done",
					output_index: 2,
					item: { type, id: "fc_a", call_id: "call_a", name: "file_system", arguments: args },
				},
			])
			expect(chunks).toEqual([
				{
					type: "tool_call_partial",
					index: 2,
					id: "call_a",
					name: "file_system",
					arguments: '{"action":"read_',
				},
				{ type: "tool_call", id: "call_a", name: "file_system", arguments: args },
			])
		},
	)

	it("uses output_item.done to complete a call even after partials", async () => {
		const args = { action: "list_directory", path: "." }
		const done = {
			type: "response.output_item.done",
			output_index: 4,
			item: {
				type: "tool_call",
				id: "fc_a",
				call_id: "call_a",
				function: { name: "file_system", arguments: args },
			},
		}
		const chunks = await collectEvents([
			added("call_a", "fc_a", 4),
			{ type: "response.function_call_arguments.delta", output_index: 4, delta: '{"action":' },
			done,
			done,
			{ type: "response.function_call_arguments.done", item_id: "fc_a", arguments: JSON.stringify(args) },
		])
		expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
			{ type: "tool_call", id: "call_a", name: "file_system", arguments: JSON.stringify(args) },
		])
	})

	it("supports argument completion without added or delta events", async () => {
		const done = {
			type: "response.function_call_arguments.done",
			call_id: "call_a",
			name: "file_system",
			arguments: '{"action":"list_directory","path":"."}',
		}
		expect(await collectEvents([done, done])).toEqual([
			{ type: "tool_call", id: "call_a", name: "file_system", arguments: done.arguments },
		])
	})

	it("retains complete arguments until a later item supplies the call identity", async () => {
		const args = '{"action":"list_directory","path":"."}'
		expect(
			await collectEvents([
				{ type: "response.function_call_arguments.done", item_id: "fc_a", output_index: 1, arguments: args },
				added("call_a", "fc_a", 1),
			]),
		).toEqual([{ type: "tool_call", id: "call_a", name: "file_system", arguments: args }])
	})

	it("does not guess the identity of ambiguous or conflicting events", async () => {
		expect(
			await collectEvents([
				added("call_a", "fc_a", 1),
				added("call_b", "fc_b", 2),
				{ type: "response.function_call_arguments.delta", delta: '{"path":"wrong"}' },
				{ type: "response.function_call_arguments.done", arguments: '{"path":"wrong"}' },
				{ type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 2, delta: "{}" },
				{ type: "response.function_call_arguments.delta", call_id: "unknown", output_index: 1, delta: "{}" },
				{ type: "response.function_call_arguments.delta", item_id: "unknown", delta: "{}" },
			]),
		).toEqual([])
	})

	it("supports identityless deltas only when there is a single known call", async () => {
		expect(
			await collectEvents([
				added("call_a", "fc_a"),
				{ type: "response.function_call_arguments.delta", delta: "{}" },
			]),
		).toEqual([{ type: "tool_call_partial", id: "call_a", name: "file_system", index: 0, arguments: "{}" }])
	})

	it("allocates unique stable parser indices for calls without output_index", async () => {
		const chunks = await collectEvents([
			added("call_a", "fc_a"),
			added("call_b", "fc_b"),
			added("call_c", "fc_c", 0),
			...["fc_a", "fc_b", "fc_c", "fc_a"].map((item_id) => ({
				type: "response.function_call_arguments.delta",
				item_id,
				delta: "{}",
			})),
		])
		expect(chunks.filter((chunk) => chunk.type === "tool_call_partial").map((chunk) => chunk.index)).toEqual([
			0, 1, 2, 0,
		])
	})

	it("does not fabricate complete arguments when completion events omit them", async () => {
		const chunks = await collectEvents([
			added("call_a", "fc_a", 0),
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: "{}" },
			{ type: "response.function_call_arguments.done", item_id: "fc_a" },
			{ ...added("call_a", "fc_a", 0), type: "response.output_item.done" },
		])
		expect(chunks).toEqual([
			{ type: "tool_call_partial", index: 0, id: "call_a", name: "file_system", arguments: "{}" },
		])
	})

	it("resets identities and completion deduplication for each request", async () => {
		const done = {
			type: "response.function_call_arguments.done",
			call_id: "call_a",
			name: "file_system",
			arguments: "{}",
		}
		expect(await collectEvents([added("call_a", "fc_a", 0), done])).toHaveLength(1)
		expect(
			await collectEvents([
				{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"stale":true}' },
				done,
			]),
		).toEqual([{ type: "tool_call", id: "call_a", name: "file_system", arguments: "{}" }])
	})

	it("uses the same identity and completion handling for manual SSE", async () => {
		const events = [
			added("call_a", "fc_a", 1),
			added("call_b", "fc_b", 2),
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"path":' },
			{ type: "response.function_call_arguments.done", item_id: "fc_a", arguments: '{"path":"a"}' },
			{ type: "response.function_call_arguments.done", item_id: "fc_b", arguments: '{"path":"b"}' },
		]
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
				)
				controller.close()
			},
		})
		const chunks: ApiStreamChunk[] = []
		for await (const chunk of (handler as any).handleStreamResponse(body, handler.getModel())) chunks.push(chunk)
		expect(chunks.filter((chunk) => chunk.type === "tool_call")).toEqual([
			{ type: "tool_call", id: "call_a", name: "file_system", arguments: '{"path":"a"}' },
			{ type: "tool_call", id: "call_b", name: "file_system", arguments: '{"path":"b"}' },
		])
	})
})
