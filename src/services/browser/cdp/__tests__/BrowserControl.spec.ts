import { EventEmitter } from "events"
import type { Browser, Page } from "puppeteer-core"
import { BrowserControl, type BrowserControlHost } from "../BrowserControl"
import {
	browserControlCommandSchema,
	type BrowserControlCommand,
} from "../../../../../packages/types/src/browser-control"
import { controlError, sanitizeBrowserUrl } from "../controlSecurity"

function fakePage(url = "https://example.org/") {
	const emitter = new EventEmitter()
	const element = {
		asElement: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
		click: vi.fn().mockResolvedValue(undefined),
		select: vi.fn().mockResolvedValue([]),
		evaluate: vi
			.fn()
			.mockImplementation(async (fn) =>
				fn.toString().includes("tag:")
					? { tag: "button", role: "button", name: "Submit", type: "", connected: true }
					: true,
			),
	}
	element.asElement.mockReturnValue(element)
	const list = {
		getProperties: vi.fn().mockResolvedValue(new Map([["0", element]])),
		dispose: vi.fn().mockResolvedValue(undefined),
	}
	return Object.assign(emitter, {
		url: vi.fn(() => url),
		isClosed: vi.fn(() => false),
		goto: vi.fn().mockImplementation(async (value) => {
			url = value
			emitter.emit("framenavigated", {})
		}),
		evaluateHandle: vi.fn().mockResolvedValue(list),
		metrics: vi.fn().mockResolvedValue({ Nodes: 10 }),
		element,
		list,
	})
}

function fixture(attached = true) {
	const page = fakePage()
	const owned = fakePage("about:blank")
	const browser = Object.assign(new EventEmitter(), {
		connected: true,
		pages: vi.fn().mockResolvedValue([page, owned]),
		close: vi.fn(),
		disconnect: vi.fn(),
	})
	const host: BrowserControlHost = {
		getBrowser: () => browser as unknown as Browser,
		isAttached: () => attached,
		isOwnedPage: (value) => !attached || value === (owned as unknown as Page),
		newPage: vi.fn().mockResolvedValue(owned),
		selectPage: vi.fn(),
		guardPage: vi.fn().mockResolvedValue(undefined),
		releasePage: vi.fn().mockResolvedValue(undefined),
		extensionHost: { platform: "linux", hostname: "test-host", remoteName: "ssh-remote" },
	}
	const control = new BrowserControl(host)
	const select = async (index = 0) => {
		const tabs = await control.control({ action: "tabs" })
		const ids = { sessionId: tabs.state.sessionId, tabId: tabs.data!.tabs![index].id }
		expect((await control.control({ action: "select_tab", ...ids })).ok).toBe(true)
		return ids
	}
	return { page, owned, browser, host, control, select }
}

describe("bounded direct CDP controls", () => {
	afterEach(() => vi.useRealTimers())

	it("reports real host, ownership, verify-only TLS and unsupported high-risk capabilities", async () => {
		const { control } = fixture()
		const result = await control.control({ action: "status" })
		expect(result.state).toMatchObject({
			ownership: "attached",
			transport: "cdp",
			certificatePolicy: "verify",
			extensionHost: { hostname: "test-host" },
			capabilities: { evaluate: false, response_body: false, debugger: false, certificate_exception: false },
		})
	})

	it.each([
		{ action: "navigate", url: "file:///etc/passwd" },
		{ action: "navigate", url: "javascript:alert(1)" },
		{ action: "navigate", url: "https://example.org", ignoreCertificateErrors: true },
		{ action: "status", approved: true },
		{ action: "tabs", timeoutMs: 0 },
		{ action: "snapshot", sessionId: "s", tabId: "t", limit: 101 },
		{ action: "raw_cdp", method: "Network.getResponseBody" },
	])("runtime rejects invalid or bypass command %j", async (input) => {
		const { control, host } = fixture()
		expect(browserControlCommandSchema.safeParse(input).success).toBe(false)
		expect((await control.control(input as BrowserControlCommand)).error?.category).toBe("invalid_command")
		expect(host.newPage).not.toHaveBeenCalled()
	})

	it("never auto-selects an existing same-domain personal tab", async () => {
		const { control, page, owned, host } = fixture()
		const result = await control.control({ action: "navigate", url: "https://example.org/new?secret=1#token" })
		expect(result.ok).toBe(true)
		expect(result.data?.url).toBe("https://example.org/new")
		expect(host.newPage).toHaveBeenCalledOnce()
		expect(page.goto).not.toHaveBeenCalled()
		expect(owned.goto).toHaveBeenCalledOnce()
	})

	it("hides privileged and unowned blank tabs, bounds the listing, and sanitizes metadata", async () => {
		const { control, browser } = fixture()
		browser.pages.mockResolvedValue([
			fakePage("about:blank"),
			fakePage("file:///private"),
			...Array.from({ length: 120 }, () => fakePage("https://user:password@example.org/page?token=secret#hash")),
		])
		const result = await control.control({ action: "tabs" })
		expect(result.data?.tabs).toHaveLength(100)
		expect(result.data?.truncated).toBe(true)
		expect(result.data?.tabs?.[0].url).toBe("https://example.org/page")
	})

	it("requires session and explicit tab selection", async () => {
		const { control } = fixture()
		const result = await control.control({ action: "tabs" })
		const tabId = result.data!.tabs![0].id
		expect((await control.control({ action: "select_tab", sessionId: "old", tabId })).error?.category).toBe(
			"stale_reference",
		)
		expect(
			(await control.control({ action: "snapshot", sessionId: result.state.sessionId, tabId })).error?.category,
		).toBe("stale_reference")
	})

	it.each(["navigation", "switch", "detach", "legacy", "close"])(
		"invalidates and disposes references on %s",
		async (event) => {
			const { control, page, browser, select } = fixture()
			const ids = await select()
			const snapshot = await control.control({ action: "snapshot", ...ids })
			const ref = snapshot.data!.elements![0].ref
			if (event === "navigation") page.emit("framenavigated", {})
			if (event === "switch") await select(1)
			if (event === "detach") {
				browser.connected = false
				browser.emit("disconnected")
			}
			if (event === "legacy") await control.suspendForLegacyAction()
			if (event === "close") page.emit("close")
			const click = await control.control({ action: "click_ref", ...ids, ref })
			expect(click.ok).toBe(false)
			expect(page.element.click).not.toHaveBeenCalled()
			expect(page.element.dispose).toHaveBeenCalledOnce()
		},
	)

	it("clicks exactly once and never retries a disconnect with unknown outcome", async () => {
		const { control, page, select } = fixture()
		const ids = await select()
		const snapshot = await control.control({ action: "snapshot", ...ids })
		page.element.click.mockRejectedValue(new Error("Target closed: secret payload"))
		const result = await control.control({ action: "click_ref", ...ids, ref: snapshot.data!.elements![0].ref })
		expect(result.error).toMatchObject({ category: "disconnected", outcomeUnknown: true })
		expect(JSON.stringify(result)).not.toContain("secret payload")
		expect(page.element.click).toHaveBeenCalledOnce()
		expect(page.element.dispose).toHaveBeenCalledOnce()
		expect(result.state.connected).toBe(false)
	})

	it("supports bounded snapshots, ref actions, inspection, styles, wait and metrics", async () => {
		const { control, page, select } = fixture()
		const ids = await select()
		const snapshot = await control.control({ action: "snapshot", ...ids, limit: 20 })
		expect(page.evaluateHandle).toHaveBeenCalledWith(expect.any(Function), 20)
		expect(snapshot.data?.elements).toEqual([expect.objectContaining({ tag: "button", name: "Submit" })])
		const ref = snapshot.data!.elements![0].ref
		for (const command of [
			{ action: "click_ref", ...ids, ref },
			{ action: "fill_ref", ...ids, ref, text: "hello" },
			{ action: "select_ref", ...ids, ref, values: ["a"] },
			{ action: "inspect", ...ids, ref },
			{ action: "styles", ...ids, ref, properties: ["display"] },
			{ action: "wait", ...ids, durationMs: 0 },
			{ action: "performance", ...ids },
		] as BrowserControlCommand[])
			expect((await control.control(command)).ok).toBe(true)
		expect(page.element.click).toHaveBeenCalledOnce()
		expect(page.element.select).toHaveBeenCalledExactlyOnceWith("a")
		expect(page.metrics).toHaveBeenCalledOnce()
	})

	it("refuses an element removed after the snapshot", async () => {
		const { control, page, select } = fixture()
		const ids = await select()
		const snapshot = await control.control({ action: "snapshot", ...ids })
		page.element.evaluate.mockResolvedValue(false)
		const result = await control.control({ action: "click_ref", ...ids, ref: snapshot.data!.elements![0].ref })
		expect(result.error?.category).toBe("stale_reference")
		expect(page.element.click).not.toHaveBeenCalled()
	})

	it("stops capture and refuses access after privileged navigation", async () => {
		const { control, page, select } = fixture()
		const ids = await select()
		page.url.mockReturnValue("chrome://settings")
		page.emit("framenavigated", {})
		expect(page.listenerCount("console")).toBe(0)
		expect((await control.control({ action: "snapshot", ...ids })).ok).toBe(false)
		expect(page.evaluateHandle).not.toHaveBeenCalled()
	})

	it("captures only selected-tab bounded console and network metadata, and removes listeners", async () => {
		const { control, page, owned, select, host } = fixture()
		const ids = await select()
		const message = { type: () => "log", text: () => "x".repeat(5000) }
		for (let index = 0; index < 100; index++) {
			page.emit("console", message)
			page.emit("request", { url: () => "https://u:p@example.org/api?secret=1#key", method: () => "GET" })
			owned.emit("console", message)
		}
		const logs = await control.control({ action: "console", ...ids })
		expect(logs.data?.console).toHaveLength(50)
		expect(logs.data?.console?.[0].text).toHaveLength(1000)
		expect(logs.warnings.join()).toContain("secrets")
		const network = await control.control({ action: "network", ...ids })
		expect(network.data?.network).toHaveLength(50)
		expect(Object.keys(network.data!.network![0]).sort()).toEqual(["method", "requestId", "url"])
		expect(network.data?.network?.[0].url).toBe("https://example.org/api")
		await control.dispose()
		expect(page.listenerCount("console")).toBe(0)
		expect(page.listenerCount("request")).toBe(0)
		expect(host.releasePage).toHaveBeenCalledWith(page)
	})

	it("fails closed after timeout and fences late asynchronous side effects", async () => {
		vi.useFakeTimers()
		const { control, host, owned } = fixture()
		let resolve!: (page: Page) => void
		vi.mocked(host.newPage).mockReturnValue(
			new Promise((done) => {
				resolve = done
			}),
		)
		const pending = control.control({ action: "navigate", url: "https://example.org", timeoutMs: 100 })
		await vi.advanceTimersByTimeAsync(100)
		expect((await pending).error).toMatchObject({ category: "timeout", outcomeUnknown: true })
		resolve(owned as unknown as Page)
		await vi.advanceTimersByTimeAsync(1)
		expect(owned.goto).not.toHaveBeenCalled()
		expect((await control.control({ action: "navigate", url: "https://example.org" })).error?.category).toBe(
			"not_connected",
		)
		expect(host.newPage).toHaveBeenCalledOnce()
	})

	it("refuses high-risk commands without invoking browser acquisition", async () => {
		const { control, page, select } = fixture()
		const ids = await select()
		for (const command of [
			{ action: "evaluate", expression: "1+1", ...ids },
			{ action: "response_body", requestId: "id", ...ids },
			{ action: "debugger", ...ids },
		] as BrowserControlCommand[]) {
			expect((await control.control(command)).error?.category).toBe("unsupported")
		}
		expect(page.evaluateHandle).not.toHaveBeenCalled()
	})

	it("does not close user browser or tabs when detached", async () => {
		const { control, browser, select } = fixture()
		await select()
		await control.dispose()
		expect(browser.close).not.toHaveBeenCalled()
		expect(browser.listenerCount("disconnected")).toBe(0)
	})

	it("categorizes certificate errors without echoing URLs or allowing bypass", () => {
		const error = controlError(new Error("net::ERR_CERT_AUTHORITY_INVALID https://user:secret@host/?token=secret"))
		expect(error.category).toBe("certificate")
		expect(error.guidance).toContain("extension host")
		expect(JSON.stringify(error)).not.toContain("secret")
		expect(sanitizeBrowserUrl("file:///secret")).toBe("[non-web URL]")
	})
})
