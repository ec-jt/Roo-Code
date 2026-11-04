type Listener = (...args: any[]) => any
describe("Chrome worker explicit attachment", () => {
	let listeners: Record<string, Listener>
	let chromeMock: any
	let fetchMock: ReturnType<typeof vi.fn>
	const sender = { id: "a".repeat(32), url: `chrome-extension://${"a".repeat(32)}/popup.html` }
	const pair = { action: "pair", endpoint: "http://127.0.0.1:1234", secret: "a".repeat(64) }
	const message = (input: unknown) => new Promise<any>((resolve) => listeners.message(input, sender, resolve))
	beforeEach(async () => {
		vi.resetModules()
		vi.useFakeTimers()
		listeners = {}
		const event = (name: string) => ({
			addListener: (listener: Listener) => {
				listeners[name] = listener
			},
		})
		chromeMock = {
			runtime: {
				id: sender.id,
				getURL: (path: string) => `chrome-extension://${sender.id}/${path}`,
				onMessage: event("message"),
				onSuspend: event("suspend"),
			},
			tabs: {
				query: vi.fn(async () => [{ id: 7, url: "https://user:secret@example.test/page?token=x#x" }]),
				get: vi.fn(async () => ({ url: "https://example.test/page" })),
				onUpdated: event("updated"),
			},
			debugger: {
				attach: vi.fn(async () => {}),
				detach: vi.fn(async () => {}),
				sendCommand: vi.fn(async () => ({})),
				onDetach: event("detach"),
				onEvent: event("event"),
			},
		}
		fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
		vi.stubGlobal("chrome", chromeMock)
		vi.stubGlobal("fetch", fetchMock)
		// @ts-expect-error Plain MV3 worker is imported with a mocked Chrome API.
		await import("../../../../../apps/browser-bridge/worker.js")
	})
	afterEach(async () => {
		await message({ action: "revoke" })
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})
	it("does not connect or attach on worker load or popup status", async () => {
		expect(await message({ action: "status" })).toEqual({ attached: false })
		expect(fetchMock).not.toHaveBeenCalled()
		expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
	})
	it("ignores messages not sent by the exact companion popup", () => {
		const respond = vi.fn()
		expect(listeners.message(pair, { ...sender, tab: { id: 1 } }, respond)).toBe(false)
		expect(listeners.message(pair, { ...sender, url: "https://evil.test" }, respond)).toBe(false)
		expect(respond).not.toHaveBeenCalled()
		expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
	})
	it("attaches only the explicitly active HTTP(S) tab and detaches on revoke", async () => {
		expect(await message(pair)).toEqual({ attached: true })
		expect(chromeMock.debugger.attach).toHaveBeenCalledExactlyOnceWith({ tabId: 7 }, "1.3")
		expect(chromeMock.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true })
		expect(chromeMock.debugger.sendCommand.mock.calls.map((call: any[]) => call[1])).toEqual([
			"Page.enable",
			"DOM.enable",
		])
		expect(await message({ action: "revoke" })).toEqual({ attached: false })
		expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 7 })
	})
	it("rejects unsupported URLs before attachment", async () => {
		chromeMock.tabs.query.mockResolvedValueOnce([{ id: 7, url: "chrome://settings" }])
		expect(await message(pair)).toHaveProperty("error")
		expect(chromeMock.debugger.attach).not.toHaveBeenCalled()
		expect(fetchMock).not.toHaveBeenCalled()
	})
	it("revokes on unsupported navigation or DevTools detach", async () => {
		await message(pair)
		listeners.updated(7, { url: "file:///private" })
		expect(await message({ action: "status" })).toEqual({ attached: false })
		await message(pair)
		listeners.detach({ tabId: 7 }, "replaced_with_devtools")
		expect(await message({ action: "status" })).toEqual({ attached: false })
	})
	it("does not retry failed authentication and detaches immediately", async () => {
		fetchMock.mockResolvedValueOnce(new Response("{}", { status: 403 }))
		expect(await message(pair)).toHaveProperty("error")
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(chromeMock.debugger.detach).toHaveBeenCalledWith({ tabId: 7 })
	})
})
