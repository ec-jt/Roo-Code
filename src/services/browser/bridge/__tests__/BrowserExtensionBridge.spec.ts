import { randomUUID } from "node:crypto"
import { request as httpRequest } from "node:http"
import nock from "nock"
import { BrowserExtensionBridge } from "../BrowserExtensionBridge"

const extensionId = "a".repeat(32)
const origin = `chrome-extension://${extensionId}`
let bridge: BrowserExtensionBridge
let credentials: { endpoint: string; secret: string }
let clientId: string
let tabId: string
let documentId: string
let sequence: number

async function send(path: string, body: unknown, headers: Record<string, string> = {}) {
	return new Promise<{ status: number; body: any; headers: Record<string, unknown> }>((resolve, reject) => {
		const request = httpRequest(
			`${credentials.endpoint}${path}`,
			{
				method: "POST",
				headers: {
					Origin: origin,
					Authorization: `Bearer ${credentials.secret}`,
					"Content-Type": "application/json",
					...headers,
				},
			},
			(response) => {
				let text = ""
				response.on("data", (chunk) => (text += chunk))
				response.on("end", () =>
					resolve({
						status: response.statusCode!,
						body: text ? JSON.parse(text) : {},
						headers: response.headers,
					}),
				)
			},
		)
		request.on("error", reject)
		request.end(JSON.stringify(body))
	})
}
const envelope = () => ({
	clientId,
	sequence: ++sequence,
	documentId,
	url: "https://user:password@example.test/path?token=secret#fragment",
})
async function pair() {
	expect((await send("/pair", { ...envelope(), tabId })).status).toBe(200)
}
async function select() {
	await pair()
	const state = bridge.getState()
	await bridge.control({ action: "select_tab", sessionId: state.sessionId, tabId })
	return state.sessionId
}

describe("authenticated loopback Chrome bridge", () => {
	beforeEach(async () => {
		bridge = new BrowserExtensionBridge({ platform: "linux", hostname: "test" })
		credentials = await bridge.start(extensionId)
		nock.enableNetConnect(new URL(credentials.endpoint).host)
		clientId = randomUUID()
		tabId = randomUUID()
		documentId = randomUUID()
		sequence = 0
	})
	afterEach(() => {
		bridge.stop()
		nock.disableNetConnect()
		vi.useRealTimers()
	})
	it("binds only loopback with a strong secret and exposes no credentials in state", () => {
		expect(credentials.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
		expect(credentials.secret).toMatch(/^[a-f0-9]{64}$/)
		expect(JSON.stringify(bridge.getState())).not.toContain(credentials.secret)
		expect(bridge.getState()).toMatchObject({
			connected: false,
			transport: "chrome-extension",
			certificatePolicy: "verify",
		})
		expect(bridge.getState().capabilities).toMatchObject({
			certificate_exception: false,
			evaluate: false,
			click_ref: false,
		})
	})
	it.each([
		{ Origin: "https://evil.test" },
		{ Origin: `chrome-extension://${"b".repeat(32)}` },
		{ Host: "localhost:1234" },
		{ Authorization: "Bearer wrong" },
		{ Authorization: "" },
	])("rejects wrong origin, host or credential %o", async (headers) => {
		const definedHeaders = Object.fromEntries(
			Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		)
		expect((await send("/pair", { ...envelope(), tabId }, definedHeaders)).status).toBe(403)
		expect(bridge.getState().connected).toBe(false)
	})
	it("rejects oversized and non-schema messages before pairing", async () => {
		expect((await send("/pair", { ...envelope(), tabId, extra: true })).status).toBe(400)
		expect((await send("/pair", { extra: "x".repeat(140_000) })).status).toBe(413)
		expect(bridge.getState().connected).toBe(false)
	})
	it("accepts one client only and rejects replay/out-of-order requests", async () => {
		await pair()
		expect((await send("/pair", { ...envelope(), clientId: randomUUID(), tabId })).status).toBe(409)
		sequence = 1
		const message = envelope()
		expect((await send("/poll", message)).status).toBe(200)
		expect((await send("/poll", message)).status).toBe(409)
		expect((await send("/poll", { ...message, sequence: 20 })).status).toBe(409)
	})
	it("requires explicit selection and sanitizes only the attached tab", async () => {
		await pair()
		const state = bridge.getState()
		const tabs = await bridge.control({ action: "tabs" })
		expect(tabs.data?.tabs).toEqual([
			{ id: tabId, url: "https://example.test/path", selected: false, owned: false },
		])
		expect((await bridge.control({ action: "snapshot", sessionId: state.sessionId, tabId })).error?.category).toBe(
			"unauthorized_page",
		)
		expect(
			(await bridge.control({ action: "select_tab", sessionId: state.sessionId, tabId: randomUUID() })).error
				?.category,
		).toBe("stale_reference")
	})
	it("delivers a typed command once and matches its strict response", async () => {
		const sessionId = await select()
		const pending = bridge.control({ action: "snapshot", sessionId, tabId, limit: 1 })
		const polled = await send("/poll", envelope())
		expect(polled.body.command).toEqual({ action: "snapshot", sessionId, tabId, limit: 1 })
		expect((await send("/poll", envelope())).body).toEqual({})
		const data = {
			elements: [{ ref: randomUUID(), tag: "button", role: "", name: "hello", type: "" }],
			truncated: false,
		}
		expect(
			(await send("/result", { ...envelope(), requestId: polled.body.requestId, ok: true, data })).status,
		).toBe(200)
		expect((await pending).data).toEqual(data)
		expect(
			(await send("/result", { ...envelope(), requestId: polled.body.requestId, ok: true, data })).status,
		).toBe(409)
	})
	it("invalidates pending references on document replacement", async () => {
		const sessionId = await select()
		const pending = bridge.control({ action: "snapshot", sessionId, tabId })
		documentId = randomUUID()
		await send("/poll", envelope())
		expect((await pending).error?.category).toBe("stale_reference")
		expect(bridge.getState().generation).toBeGreaterThan(1)
	})
	it("revokes outstanding work and invalidates session IDs on close", async () => {
		const sessionId = await select()
		const pending = bridge.control({ action: "wait", sessionId, tabId, durationMs: 1 })
		bridge.stop()
		expect((await pending).error?.category).toBe("disconnected")
		expect(bridge.getState().sessionId).not.toBe(sessionId)
		expect(bridge.getState().connected).toBe(false)
		await expect(send("/poll", envelope())).rejects.toThrow()
	})
	it("expires unpaired credentials without reconnecting", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(Date.now() + 121_000)
		expect((await send("/pair", { ...envelope(), tabId })).status).toBe(403)
		expect(bridge.getState().connected).toBe(false)
	})
})
