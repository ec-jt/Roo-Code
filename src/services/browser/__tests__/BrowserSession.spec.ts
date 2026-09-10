import type * as vscode from "vscode"
import * as fs from "fs/promises"
// @ts-ignore - resolver does not publish types, matching BrowserSession.
import PCR from "puppeteer-chromium-resolver"
import { launch, connect } from "puppeteer-core"
import { BrowserSession } from "../BrowserSession"
import { discoverChromeHostUrl } from "../browserDiscovery"

vi.mock("puppeteer-core", () => ({ launch: vi.fn(), connect: vi.fn(), TimeoutError: class extends Error {} }))
vi.mock("puppeteer-chromium-resolver", () => ({ default: vi.fn() }))
vi.mock("fs/promises", () => ({ mkdir: vi.fn(), readdir: vi.fn(), mkdtemp: vi.fn(), rm: vi.fn() }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(true) }))
vi.mock("../browserDiscovery", () => ({ discoverChromeHostUrl: vi.fn(), tryChromeHostUrl: vi.fn() }))

describe("sandboxed browser launch", () => {
	let settings: Record<string, unknown>
	let session: BrowserSession
	let onStateChange: ReturnType<typeof vi.fn>
	const close = vi.fn()
	const disconnect = vi.fn()

	beforeEach(() => {
		vi.resetAllMocks()
		close.mockResolvedValue(undefined)
		disconnect.mockResolvedValue(undefined)
		vi.mocked(fs.rm).mockResolvedValue(undefined)
		vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 1000 })
		vi.stubEnv("DISPLAY", ":1")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		settings = {}
		onStateChange = vi.fn()
		session = new BrowserSession(
			{
				globalStorageUri: { fsPath: "/storage" },
				globalState: { get: (key: string) => settings[key], update: vi.fn() },
			} as unknown as vscode.ExtensionContext,
			onStateChange,
		)
		vi.mocked(PCR).mockResolvedValue({ executablePath: "/chromium", puppeteer: { launch } })
		vi.mocked(fs.readdir).mockResolvedValue([])
		vi.mocked(fs.mkdtemp).mockResolvedValue("/tmp/roo-browser-profile-test")
		vi.mocked(launch).mockResolvedValue({ close, disconnect } as never)
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
	})

	it.each([undefined, false, true])("keeps sandbox and native user agent with headed=%s", async (headed) => {
		settings.browserHeaded = headed
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				headless: !headed,
				args: [],
				defaultViewport: { width: 900, height: 600, deviceScaleFactor: 1 },
			}),
		)
		expect(onStateChange).toHaveBeenCalledWith(true)
		await session.closeBrowser()
		expect(close).toHaveBeenCalledOnce()
	})

	it("uses Wayland for a Wayland-only visible session", async () => {
		settings.browserHeaded = true
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0")
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(
			expect.objectContaining({ headless: false, args: ["--ozone-platform=wayland"] }),
		)
	})

	it("falls back to headless when headed mode has no display", async () => {
		settings.browserHeaded = true
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }))
	})

	it("allows headless mode without a display", async () => {
		vi.stubEnv("DISPLAY", "")
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }))
	})

	it("falls back to headless for root without disabling the sandbox", async () => {
		settings.browserHeaded = true
		vi.stubGlobal("process", { ...process, getuid: () => 0 })
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true, args: [] }))
	})

	it.each(["No usable sandbox", "Missing X server or $DISPLAY"])(
		"reports %s and cleans up without retry",
		async (message) => {
			settings.browserHeaded = true
			vi.mocked(launch).mockRejectedValue(new Error(message))
			await expect(session.launchBrowser()).rejects.toThrow(message)
			expect(launch).toHaveBeenCalledOnce()
			expect(fs.rm).toHaveBeenCalledWith("/tmp/roo-browser-profile-test", { recursive: true, force: true })
			expect(onStateChange).not.toHaveBeenCalled()
			await session.closeBrowser()
			expect(close).not.toHaveBeenCalled()
		},
	)

	it("falls back to headless without a display on other platforms", async () => {
		vi.stubGlobal("process", { ...process, platform: "darwin" })
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		settings.browserHeaded = true
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true }))
	})

	it("fails remote discovery without launching a local browser", async () => {
		settings.remoteBrowserEnabled = true
		await expect(session.launchBrowser()).rejects.toThrow("No local fallback")
		expect(launch).not.toHaveBeenCalled()
		expect(onStateChange).not.toHaveBeenCalled()
	})

	it("preserves remote connection and disconnect semantics", async () => {
		settings.remoteBrowserEnabled = true
		vi.mocked(discoverChromeHostUrl).mockResolvedValue("http://localhost:9222")
		vi.mocked(connect).mockResolvedValue({ disconnect } as never)
		await session.launchBrowser()
		await session.closeBrowser()
		expect(disconnect).toHaveBeenCalledOnce()
		expect(close).not.toHaveBeenCalled()
		expect(launch).not.toHaveBeenCalled()
	})
})
