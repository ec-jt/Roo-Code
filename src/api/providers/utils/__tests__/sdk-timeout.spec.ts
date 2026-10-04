import OpenAI from "openai"
import Anthropic from "@anthropic-ai/sdk"
import { getGlobalDispatcher, setGlobalDispatcher, MockAgent } from "undici"
import { configureApiRequestTimeout } from "../sdk-timeout"

// These are the installed SDKs, not constructor mocks. Fetch is the only
// boundary replaced, so SDK request, timeout and error paths all execute.
const sdks = [
	{
		name: "OpenAI",
		create: (timeout?: number) => new OpenAI({ apiKey: "test-key", maxRetries: 0, timeout }),
		request: (client: OpenAI | Anthropic, options: { signal?: AbortSignal; timeout?: number } = {}) =>
			(client as OpenAI).chat.completions.create({ model: "test", messages: [] }, options),
		stream: (client: OpenAI | Anthropic, signal: AbortSignal) =>
			(client as OpenAI).chat.completions.create({ model: "test", messages: [], stream: true }, { signal }),
		event: 'data: {"id":"chunk","choices":[]}\n\n',
	},
	{
		name: "Anthropic",
		create: (timeout?: number) => new Anthropic({ apiKey: "test-key", maxRetries: 0, timeout }),
		request: (client: OpenAI | Anthropic, options: { signal?: AbortSignal; timeout?: number } = {}) =>
			(client as Anthropic).messages.create({ model: "test", max_tokens: 1, messages: [] }, options),
		stream: (client: OpenAI | Anthropic, signal: AbortSignal) =>
			(client as Anthropic).messages.create(
				{ model: "test", max_tokens: 1, messages: [], stream: true },
				{ signal },
			),
		event: 'event: message_start\ndata: {"type":"message_start","message":{"id":"chunk"}}\n\n',
	},
]

function pendingFetch() {
	let signal: AbortSignal
	let resolve: (response: Response) => void
	const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => {
		signal = init!.signal!
		return new Promise<Response>((res, reject) => {
			resolve = res
			if (signal.aborted) reject(new DOMException("Aborted", "AbortError"))
			else
				signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				})
		})
	})
	return { fetch, signal: () => signal, resolve: (response: Response) => resolve(response) }
}

describe.each(sdks)("$name SDK timeout transport", (sdk) => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("confirms the installed SDK restores 600000 ms when timeout is undefined", () => {
		expect(sdk.create(undefined).timeout).toBe(600_000)
	})

	it("uses the global dispatcher and disables transport header/body deadlines", async () => {
		const original = getGlobalDispatcher()
		const dispatcher = new MockAgent()
		dispatcher.disableNetConnect()
		const origin = sdk.name === "OpenAI" ? "https://api.openai.com" : "https://api.anthropic.com"
		const path = sdk.name === "OpenAI" ? "/v1/chat/completions" : "/v1/messages"
		dispatcher
			.get(origin)
			.intercept({ path, method: "POST" })
			.reply(
				200,
				{ id: "transport-result" },
				{
					headers: { "content-type": "application/json" },
				},
			)
		const dispatch = vi.spyOn(dispatcher, "dispatch")
		setGlobalDispatcher(dispatcher)
		try {
			const client = configureApiRequestTimeout(sdk.create(0))
			await expect(sdk.request(client)).resolves.toMatchObject({ id: "transport-result" })
			expect(dispatch).toHaveBeenCalledWith(
				expect.objectContaining({ headersTimeout: 0, bodyTimeout: 0 }),
				expect.anything(),
			)
		} finally {
			setGlobalDispatcher(original)
			await dispatcher.close()
		}
	})

	it("allows an unlimited request to finish beyond the SDK default and Node timer range", async () => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(0), pending.fetch)
		const result = sdk.request(client).then((value) => value)
		await vi.advanceTimersByTimeAsync(0)
		expect(pending.fetch).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(2 ** 31 + 600_001)
		expect(pending.signal().aborted).toBe(false)
		pending.resolve(new Response('{"id":"finished"}', { headers: { "content-type": "application/json" } }))
		await expect(result).resolves.toMatchObject({ id: "finished" })
	})

	it.each([0, 1200])("preserves caller cancellation with timeout %s", async (timeout) => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(timeout), pending.fetch)
		const controller = new AbortController()
		const result = sdk.request(client, { signal: controller.signal }).then(
			() => undefined,
			(error: Error) => error,
		)
		await vi.advanceTimersByTimeAsync(0)
		controller.abort()
		expect(await result).toMatchObject({ name: "Error", message: "Request was aborted." })
		expect(pending.signal().aborted).toBe(true)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not dispatch an already-aborted request", async () => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(0), pending.fetch)
		const controller = new AbortController()
		controller.abort()
		await expect(sdk.request(client, { signal: controller.signal })).rejects.toThrow("Request was aborted.")
		expect(pending.fetch).not.toHaveBeenCalled()
	})

	it.each([1200, 2 ** 31 + 1200])("honors an explicit %s ms deadline without timer overflow", async (timeout) => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(timeout), pending.fetch)
		const result = sdk.request(client).then(
			() => undefined,
			(error: Error) => error,
		)
		await vi.advanceTimersByTimeAsync(timeout - 1)
		expect(pending.signal().aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(pending.signal().aborted).toBe(true)
		expect(await result).toMatchObject({ message: "Request timed out." })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("honors a positive per-request override of an unlimited client", async () => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(0), pending.fetch)
		const result = sdk.request(client, { timeout: 25 }).catch((error: Error) => error)
		await vi.advanceTimersByTimeAsync(24)
		expect(pending.signal().aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(await result).toMatchObject({ message: "Request timed out." })
	})

	it("clears the positive deadline after headers but preserves body cancellation", async () => {
		const pending = pendingFetch()
		const client = configureApiRequestTimeout(sdk.create(10), pending.fetch)
		const controller = new AbortController()
		const result = sdk.request(client, { signal: controller.signal }).then((value) => value)
		await vi.advanceTimersByTimeAsync(0)
		pending.resolve(new Response('{"id":"finished"}', { headers: { "content-type": "application/json" } }))
		await result
		await vi.advanceTimersByTimeAsync(600_001)
		expect(pending.signal().aborted).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
		controller.abort()
		expect(pending.signal().aborted).toBe(true)
	})

	it.each(["caller", "stream controller"])(
		"preserves %s cancellation during a long-running SDK stream",
		async (source) => {
			let body!: ReadableStreamDefaultController<Uint8Array>
			let signal!: AbortSignal
			const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
				signal = init!.signal!
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							body = controller
							signal.addEventListener(
								"abort",
								() => controller.error(new DOMException("Aborted", "AbortError")),
								{ once: true },
							)
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				)
			})
			const client = configureApiRequestTimeout(sdk.create(0), fetch)
			const controller = new AbortController()
			const stream = await sdk.stream(client, controller.signal)
			const iterator = stream[Symbol.asyncIterator]()
			const first = iterator.next()
			await vi.advanceTimersByTimeAsync(600_001)
			expect(signal.aborted).toBe(false)
			body.enqueue(new TextEncoder().encode(sdk.event))
			expect((await first).done).toBe(false)
			const next = iterator.next()
			if (source === "caller") controller.abort()
			else stream.controller.abort()
			expect(signal.aborted).toBe(true)
			await expect(next).resolves.toMatchObject({ done: true })
			expect(vi.getTimerCount()).toBe(0)
		},
	)
})
