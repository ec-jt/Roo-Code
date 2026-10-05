import OpenAI from "openai"

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import type { ApiStream, ApiStreamChunk } from "../../transform/stream"

const partialOutputs = [
	{ label: "no output", events: [], chunks: [] },
	{
		label: "text delta",
		events: [{ type: "response.output_text.delta", delta: "Partial text" }],
		chunks: [{ type: "text", text: "Partial text" }],
	},
	{
		label: "tool argument delta",
		events: [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
			},
			{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":' },
		],
		chunks: [{ type: "tool_call_partial", index: 0, id: "call_1", name: "read_file", arguments: '{"path":' }],
	},
]

describe.each(["installed SDK", "manual SSE"])("OpenAI Codex terminal events via %s", (transport) => {
	let handler: OpenAiCodexHandler
	let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

	beforeEach(() => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		vi.spyOn(openAiCodexOAuthManager, "forceRefreshAccessToken").mockResolvedValue("refreshed-token")
		fetchMock = vi.fn<typeof fetch>()
		vi.stubGlobal("fetch", fetchMock)
		handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5" })
		// Exercise the installed SDK's real SSE decoder, not a mocked event iterator.
		// A missing Responses API forces the manual path without sending an SDK request.
		;(handler as unknown as { client: unknown }).client =
			transport === "installed SDK" ? new OpenAI({ apiKey: "test-token", fetch: fetchMock }) : {}
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	function serve(events: unknown[], prefix = "") {
		const body = prefix + events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n"
		// Return a fresh HTTP 200 stream on every call so an unintended retry cannot
		// hide behind a consumed response body. All transport calls stay local.
		fetchMock.mockImplementation(
			async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
		)
	}

	async function consume(chunks: ApiStreamChunk[] = []) {
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
			chunks.push(chunk)
		}
		return chunks
	}

	function expectNoReplay() {
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(openAiCodexOAuthManager.forceRefreshAccessToken).not.toHaveBeenCalled()
	}

	describe.each(partialOutputs)("after $label", ({ events, chunks: expectedChunks }) => {
		it.each([
			{
				status: "failed",
				detail: { error: { code: "server_error", message: "401 unauthorized" } },
				reason: "server_error",
			},
			{
				status: "failed",
				detail: { error: { code: "authentication_error", message: "401 unauthorized" } },
				reason: "authentication_error",
			},
			{
				status: "incomplete",
				detail: { incomplete_details: { reason: "max_output_tokens" } },
				reason: "max_output_tokens",
			},
			{
				status: "incomplete",
				detail: { incomplete_details: { reason: "content_filter" } },
				reason: "content_filter",
			},
		])("rejects $status ($reason) without replay", async ({ status, detail, reason }) => {
			serve([
				{ type: "response.created", response: { id: "resp_1" } },
				...events,
				{
					type: `response.${status}`,
					response: {
						id: "resp_1",
						status,
						...detail,
						// A failed payload may still contain output and usage. It must not
						// be interpreted as a successful completed response.
						output: [{ type: "text", content: [{ type: "text", text: "Do not emit" }] }],
						usage: { input_tokens: 3, output_tokens: 4 },
					},
				},
				{ type: "response.output_text.delta", delta: "Do not consume past the terminal event" },
			])
			const chunks: ApiStreamChunk[] = []
			await expect(consume(chunks)).rejects.toThrow(`OpenAI Codex response ${status} (${reason}).`)
			expect(chunks).toEqual(expectedChunks)
			expectNoReplay()
		})
	})

	it.each(["failed", "incomplete"])("rejects %s even without error details", async (status) => {
		serve([{ type: `response.${status}` }])
		await expect(consume()).rejects.toThrow(`OpenAI Codex response ${status}.`)
		expectNoReplay()
	})

	it.each(["failed", "incomplete"])("does not expose arbitrary %s payload data", async (status) => {
		const privateData = "synthetic-private-payload"
		serve([
			{
				type: `response.${status}`,
				response: {
					error: { code: privateData, message: `401 unauthorized Bearer ${privateData}` },
					incomplete_details: { reason: privateData },
					output: [{ type: "reasoning", encrypted_content: privateData }],
				},
			},
		])
		await expect(consume()).rejects.toHaveProperty("message", `OpenAI Codex response ${status}.`)
		expectNoReplay()
	})

	it.each(partialOutputs)(
		"preserves completed responses after $label",
		async ({ events, chunks: expectedChunks }) => {
			serve([
				...events,
				{
					type: "response.completed",
					response: {
						id: "resp_completed",
						output: [{ type: "message", content: [{ type: "output_text", text: "Final text" }] }],
						usage: { input_tokens: 3, output_tokens: 4 },
					},
				},
			])
			const chunks = await consume()
			expect(chunks).toEqual([
				...expectedChunks,
				...(expectedChunks.some((chunk) => chunk.type === "text")
					? []
					: [{ type: "text", text: "Final text" }]),
				{
					type: "usage",
					inputTokens: 3,
					outputTokens: 4,
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			])
			expect(handler.getResponseId()).toBe("resp_completed")
			expectNoReplay()
		},
	)

	if (transport === "manual SSE") {
		it("ignores malformed JSON but propagates a following terminal failure", async () => {
			serve([{ type: "response.failed", response: { error: { code: "server_error" } } }], "data: {broken\n\n")
			await expect(consume()).rejects.toThrow("OpenAI Codex response failed (server_error).")
			expectNoReplay()
		})

		it("does not swallow syntax errors raised by event processing", async () => {
			serve([{ type: "response.output_text.delta", delta: "text" }])
			vi.spyOn(handler as unknown as { processEvent: () => ApiStream }, "processEvent").mockImplementation(
				async function* () {
					yield* []
					throw new SyntaxError("Event processing failed")
				},
			)
			await expect(consume()).rejects.toThrow()
			expectNoReplay()
		})
	}
})
