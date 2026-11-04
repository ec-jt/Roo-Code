import type * as vscode from "vscode"
import { launch, connect } from "puppeteer-core"
import { BrowserSession } from "../../BrowserSession"

vi.mock("puppeteer-core", () => ({ launch: vi.fn(), connect: vi.fn(), TimeoutError: class extends Error {} }))
vi.mock("puppeteer-chromium-resolver", () => ({ default: vi.fn() }))
vi.mock("../../browserDiscovery", () => ({ discoverChromeHostUrl: vi.fn(), tryChromeHostUrl: vi.fn() }))

describe("BrowserSession bridge transport seam", () => {
	let session: BrowserSession
	beforeEach(() => {
		vi.clearAllMocks()
		session = new BrowserSession({ globalState: { get: vi.fn() } } as unknown as vscode.ExtensionContext)
	})
	afterEach(async () => {
		await session.dispose()
	})
	it("dispatches typed controls to bridge while refusing every legacy entry point", async () => {
		await session.startExtensionBridge("a".repeat(32))
		expect((await session.control({ action: "status" })).state.transport).toBe("chrome-extension")
		for (const action of [
			() => session.launchBrowser(),
			() => session.navigateToUrl("https://example.test"),
			() => session.click("1,1"),
			() => session.captureFullPage(),
			() => session.saveScreenshot("unused.png", "/unused"),
		])
			await expect(action()).rejects.toThrow("Chrome extension transport is active")
		expect(launch).not.toHaveBeenCalled()
		expect(connect).not.toHaveBeenCalled()
	})
	it("close revokes credentials and restores disconnected CDP state without closing user tabs", async () => {
		await session.startExtensionBridge("a".repeat(32))
		const previous = session.getControlState().sessionId
		await session.closeBrowser()
		expect(session.getControlState()).toMatchObject({ transport: "cdp", connected: false })
		expect(session.getControlState().sessionId).not.toBe(previous)
		expect(launch).not.toHaveBeenCalled()
	})
	it("dispose prevents another listener from starting", async () => {
		await session.startExtensionBridge("a".repeat(32))
		await session.dispose()
		await expect(session.startExtensionBridge("a".repeat(32))).rejects.toThrow("disposed")
	})
})
