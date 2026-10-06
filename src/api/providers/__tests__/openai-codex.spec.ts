// npx vitest run api/providers/__tests__/openai-codex.spec.ts

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import type { ApiStreamChunk } from "../../transform/stream"

describe("OpenAiCodexHandler.getModel", () => {
	it("resolves Sol 6.1 without changing the subscription provider default", () => {
		const model = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" }).getModel()
		expect(model.id).toBe("gpt-6.1-sol")
		expect(model.info).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128000,
			inputPrice: 0,
			outputPrice: 0,
			requiredReasoningEffort: true,
			reasoningEffort: "medium",
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		})
		expect(new OpenAiCodexHandler({}).getModel().id).toBe("gpt-5.6-sol")
	})

	it.each(["gpt-5.1", "gpt-5", "gpt-5.1-codex", "gpt-5-codex", "gpt-5-codex-mini", "gpt-5.3-codex-spark"])(
		"should return specified model when a valid model id is provided: %s",
		(apiModelId) => {
			const handler = new OpenAiCodexHandler({ apiModelId })
			const model = handler.getModel()

			expect(model.id).toBe(apiModelId)
			expect(model.info).toBeDefined()
			// Default reasoning effort for GPT-5 family
			expect(model.info.reasoningEffort).toBe("medium")
		},
	)

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.6-sol")
		expect(model.info).toBeDefined()
	})

	it("should use Spark-specific limits and capabilities", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.3-codex-spark" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.3-codex-spark")
		expect(model.info.contextWindow).toBe(128000)
		expect(model.info.maxTokens).toBe(8192)
		expect(model.info.supportsImages).toBe(false)
	})

	it("should use GPT-5.4 Mini capabilities when selected", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.4-mini" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-5.4-mini")
		expect(model.info).toBeDefined()
	})
})

describe("OpenAiCodexHandler SDK fallback", () => {
	let handler: OpenAiCodexHandler
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		vi.spyOn(openAiCodexOAuthManager, "forceRefreshAccessToken").mockResolvedValue("refreshed-token")
		handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5" })
		fetchMock = vi.fn().mockResolvedValue(
			new Response('data: {"type":"response.output_text.delta","delta":"fallback text"}\n\ndata: [DONE]\n\n', {
				headers: { "Content-Type": "text/event-stream" },
			}),
		)
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	async function consume(chunks: ApiStreamChunk[] = []) {
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
			chunks.push(chunk)
		}
		return chunks
	}

	it.each([
		[undefined, "medium"],
		["disable", "medium"],
		["none", "medium"],
		["minimal", "medium"],
		["low", "low"],
		["medium", "medium"],
		["high", "high"],
		["xhigh", "xhigh"],
		["max", "max"],
	] as const)("sends supported Sol 6.1 effort for setting %s", async (reasoningEffort, expected) => {
		handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol", reasoningEffort })
		const create = vi.fn().mockImplementation(async function* () {
			yield { type: "response.output_text.delta", delta: "answer" }
		})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		await consume()
		expect(create.mock.calls[0][0]).toMatchObject({
			model: "gpt-6.1-sol",
			reasoning: { effort: expected },
			include: ["reasoning.encrypted_content"],
		})
		expect(create.mock.calls[0][0].temperature).toBeUndefined()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		["missing Responses API", {}],
		["missing create method", { responses: {} }],
		["non-streaming response", { responses: { create: vi.fn().mockResolvedValue({}) } }],
	])("allows early compatibility fallback for %s", async (_label, client) => {
		;(handler as unknown as { client: unknown }).client = client
		expect(await consume()).toContainEqual({ type: "text", text: "fallback text" })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it.each([
		new Error("SDK request failed"),
		new TypeError("Cannot read properties of undefined (reading 'create')"),
		Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }),
		Object.assign(new Error("Request was aborted"), { name: "APIUserAbortError" }),
		new DOMException("Request was aborted", "AbortError"),
	])("does not fall back for an early request failure: $name ($message)", async (error) => {
		const create = vi.fn().mockRejectedValue(error)
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		await expect(consume()).rejects.toBe(error)
		expect(create).toHaveBeenCalledTimes(1)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(openAiCodexOAuthManager.forceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("does not fall back after cancellation even if the SDK returns a non-streaming response", async () => {
		const create = vi.fn().mockImplementation(async () => {
			;(handler as unknown as { abortController: AbortController }).abortController.abort()
			return {}
		})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		await expect(consume()).rejects.toThrow("OpenAI SDK did not return an AsyncIterable")
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		{
			label: "text",
			events: [{ type: "response.output_text.delta", delta: "first text" }],
			chunk: { type: "text", text: "first text" },
		},
		{
			label: "reasoning",
			events: [{ type: "response.reasoning_text.delta", delta: "first reasoning" }],
			chunk: { type: "reasoning", text: "first reasoning" },
		},
		{
			label: "tool arguments",
			events: [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
				},
				{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":' },
			],
			chunk: { type: "tool_call_partial", arguments: '{"path":' },
		},
	])("does not replay after $label output", async ({ events, chunk }) => {
		const error = new Error("stream disconnected")
		const create = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield* events
				throw error
			},
		})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		const chunks: ApiStreamChunk[] = []
		await expect(consume(chunks)).rejects.toBe(error)
		expect(chunks).toContainEqual(expect.objectContaining(chunk))
		expect(create).toHaveBeenCalledTimes(1)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("does not replay a midstream failure before visible output", async () => {
		const error = new Error("stream disconnected")
		const create = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.created", response: { id: "resp_1" } }
				throw error
			},
		})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		await expect(consume()).rejects.toBe(error)
		expect(create).toHaveBeenCalledTimes(1)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("does not retry authentication after observable output", async () => {
		const error = new Error("401 unauthorized")
		const create = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.reasoning_text.delta", delta: "first reasoning" }
				throw error
			},
		})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		await expect(consume()).rejects.toBe(error)
		expect(create).toHaveBeenCalledTimes(1)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(openAiCodexOAuthManager.forceRefreshAccessToken).not.toHaveBeenCalled()
	})

	it("still refreshes authentication before output", async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce(new Error("401 unauthorized"))
			.mockResolvedValueOnce({
				async *[Symbol.asyncIterator]() {
					yield { type: "response.output_text.delta", delta: "authenticated text" }
				},
			})
		;(handler as unknown as { client: unknown }).client = { responses: { create } }
		expect(await consume()).toEqual([{ type: "text", text: "authenticated text" }])
		expect(create).toHaveBeenCalledTimes(2)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(openAiCodexOAuthManager.forceRefreshAccessToken).toHaveBeenCalledTimes(1)
	})
})
