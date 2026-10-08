import { OpenAiNativeHandler } from "../openai-native"
import { summarizeConversation } from "../../../core/condense"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("openai", () => ({
	default: vi.fn().mockImplementation(() => ({ responses: { create } })),
}))

const messages: ApiMessage[] = [
	{ role: "user", content: "Original task" },
	{ role: "assistant", content: "Original answer" },
	{ role: "user", content: "Continue" },
]
const partial = { type: "response.output_text.delta", delta: "Partial summary" }
const failed = {
	type: "response.failed",
	response: { error: { code: "server_error", message: "secret provider payload" } },
}

function sseBody(events: unknown[], prefix = "") {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				new TextEncoder().encode(prefix + events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
			)
			controller.close()
		},
	})
}

describe("OpenAI Native generation failure ownership", () => {
	let handler: OpenAiNativeHandler
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		create.mockReset()
		handler = new OpenAiNativeHandler({ apiModelId: "gpt-4.1", openAiNativeApiKey: "test-key" })
		fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => vi.unstubAllGlobals())

	function setEvents(transport: string, events: unknown[], prefix = "") {
		if (transport === "SDK") {
			create.mockResolvedValue(
				(async function* () {
					yield* events
				})(),
			)
		} else {
			create.mockResolvedValue({})
			fetchMock.mockResolvedValue({ ok: true, body: sseBody(events, prefix) })
		}
	}

	it.each(["AbortError", "APIConnectionError", "APIConnectionTimeoutError", "Error"])(
		"does not retry %s before or after output and preserves error identity",
		async (name) => {
			const error = Object.assign(new Error("SDK not available"), { name, code: "transport_failure" })
			create.mockRejectedValueOnce(error)
			await expect(handler.createMessage("system", messages).next()).rejects.toBe(error)
			create.mockResolvedValueOnce(
				(async function* () {
					yield partial
					throw error
				})(),
			)
			const stream = handler.createMessage("system", messages)
			expect((await stream.next()).value).toEqual({ type: "text", text: partial.delta })
			await expect(stream.next()).rejects.toBe(error)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it.each(["missing create", "non-streaming response"])("supports compatibility fallback: %s", async (kind) => {
		if (kind === "missing create") (handler as any).client.responses = undefined
		else create.mockResolvedValue({})
		fetchMock.mockResolvedValue({ ok: true, body: sseBody([partial, { type: "response.completed" }]) })
		const chunks = []
		for await (const chunk of handler.createMessage("system", messages)) chunks.push(chunk)
		expect(chunks).toEqual([{ type: "text", text: partial.delta }])
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	describe.each(["SDK", "SSE"])("%s terminal events", (transport) => {
		it.each([
			failed,
			{ type: "response.error", error: { code: "server_error", message: "secret provider payload" } },
			{ type: "error", code: "server_error", message: "secret provider payload" },
			{ type: "response.failed" },
			{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
			{ type: "response.done", response: { status: "incomplete" } },
		])("rejects $type after partial output without replay", async (terminal) => {
			setEvents(transport, [partial, terminal])
			const stream = handler.createMessage("system", messages)
			expect((await stream.next()).value).toEqual({ type: "text", text: partial.delta })
			await expect(stream.next()).rejects.toThrow(/OpenAI Native response (failed|incomplete)/)
			expect(create).toHaveBeenCalledTimes(1)
			expect(fetchMock).toHaveBeenCalledTimes(transport === "SDK" ? 0 : 1)
		})

		it("does not expose raw terminal payloads or arbitrary codes", async () => {
			setEvents(transport, [{ ...failed, response: { error: { code: "secret-code", message: "secret-text" } } }])
			await expect(handler.createMessage("system", messages).next()).rejects.toMatchObject({
				message: "OpenAI Native response failed.",
				code: undefined,
			})
		})

		it("preserves structured context-limit rejection through all layers", async () => {
			setEvents(transport, [{ ...failed, response: { error: { code: "context_window_exceeded" } } }])
			await expect(handler.createMessage("system", messages).next()).rejects.toMatchObject({
				code: "context_length_exceeded",
			})
		})

		it("rejects cancellation after partial output instead of returning success", async () => {
			setEvents(transport, [partial, { type: "response.completed" }])
			const stream = handler.createMessage("system", messages)
			await stream.next()
			const error = Object.assign(new Error("cancelled"), { name: "AbortError" })
			;(handler as any).abortController.abort(error)
			await expect(stream.next()).rejects.toBe(error)
			expect(fetchMock).toHaveBeenCalledTimes(transport === "SDK" ? 0 : 1)
		})

		it("does not commit a nonempty partial summary after failure", async () => {
			setEvents(transport, [partial, failed])
			const original = structuredClone(messages)
			const result = await summarizeConversation({
				messages: original,
				apiHandler: handler,
				systemPrompt: "system",
				taskId: "test-task",
			})
			expect(result.error).toBeTruthy()
			expect(result.errorDetails).toContain("server_error")
			expect(result.errorDetails).not.toContain("secret provider payload")
			expect(result.summary).toBe("")
			expect(result.messages).toEqual(messages)
			expect(original).toEqual(messages)
			expect(result.condenseId).toBeUndefined()
		})
	})

	it("skips malformed SSE but rejects the subsequent error event", async () => {
		setEvents("SSE", [partial, failed], "data: {malformed\n\n")
		const stream = handler.createMessage("system", messages)
		expect((await stream.next()).value).toEqual({ type: "text", text: partial.delta })
		await expect(stream.next()).rejects.toMatchObject({ code: "server_error" })
	})

	it("rejects terminal failures in the legacy JSON-line path", async () => {
		setEvents("SSE", [], `{malformed\n${JSON.stringify(failed)}\n`)
		await expect(handler.createMessage("system", messages).next()).rejects.toMatchObject({ code: "server_error" })
	})

	it("preserves a manual SSE transport error through all layers", async () => {
		const error = Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
		create.mockResolvedValue({})
		let reads = 0
		fetchMock.mockResolvedValue({
			ok: true,
			body: new ReadableStream<Uint8Array>({
				pull(controller) {
					if (reads++ === 0)
						controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(partial)}\n\n`))
					else controller.error(error)
				},
			}),
		})
		const stream = handler.createMessage("system", messages)
		await stream.next()
		await expect(stream.next()).rejects.toBe(error)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})
