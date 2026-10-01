// cd src && npx vitest run api/providers/__tests__/openai-codex-headers.spec.ts

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

describe("OpenAiCodexHandler Codex headers", () => {
	let handler: OpenAiCodexHandler

	beforeEach(() => {
		vi.restoreAllMocks()
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.5" })
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("sends OpenAI-Beta and x-client-request-id on the SDK streaming request", async () => {
		const createMock = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.completed",
					response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
				}
			},
		})

		;(handler as never as { client: unknown }).client = { responses: { create: createMock } }

		const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as never], {
			taskId: "task-123",
			tools: [],
		})

		for await (const _chunk of stream) {
			// consume the stream
		}

		expect(createMock).toHaveBeenCalledTimes(1)
		const headers = createMock.mock.calls[0][1].headers
		expect(headers["OpenAI-Beta"]).toBe("responses=experimental")
		expect(headers["x-client-request-id"]).toBe("task-123")
		expect(headers["session_id"]).toBe("task-123")
	})

	it("sends OpenAI-Beta and x-client-request-id on the fetch fallback request", async () => {
		// Force the SDK path to throw so the handler falls back to the manual SSE fetch.
		;(handler as never as { client: unknown }).client = {
			responses: { create: vi.fn().mockRejectedValue(new Error("sdk unavailable")) },
		}

		const fetchMock = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			text: async () => "boom",
			body: null,
		})
		vi.stubGlobal("fetch", fetchMock)

		const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as never], {
			taskId: "task-abc",
			tools: [],
		})

		await expect(
			(async () => {
				for await (const _chunk of stream) {
					// consume the stream
				}
			})(),
		).rejects.toThrow()

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const init = fetchMock.mock.calls[0][1]
		expect(init.headers["OpenAI-Beta"]).toBe("responses=experimental")
		expect(init.headers["x-client-request-id"]).toBe("task-abc")
		expect(init.headers["session_id"]).toBe("task-abc")
	})
})
