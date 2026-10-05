import type * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
// @ts-ignore - resolver does not publish types, matching BrowserSession.
import PCR from "puppeteer-chromium-resolver"
import { launch, connect } from "puppeteer-core"
import { BrowserSession } from "../BrowserSession"
import { discoverChromeHostUrl } from "../browserDiscovery"

vi.mock("puppeteer-core", () => ({ launch: vi.fn(), connect: vi.fn(), TimeoutError: class extends Error {} }))
vi.mock("puppeteer-chromium-resolver", () => ({ default: vi.fn() }))
vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readdir: vi.fn(),
	mkdtemp: vi.fn(),
	rm: vi.fn(),
	stat: vi.fn(),
	access: vi.fn(),
}))
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

	it.each(["darwin", "win32"])("uses headed mode without Linux display variables on %s", async (platform) => {
		vi.stubGlobal("process", { ...process, platform })
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		settings.browserHeaded = true
		await session.launchBrowser()
		expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false, args: [] }))
	})

	it("never removes profiles owned by independent concurrent sessions", async () => {
		const other = new BrowserSession((session as any).context)
		vi.mocked(fs.mkdtemp).mockResolvedValueOnce("/tmp/profile-a").mockResolvedValueOnce("/tmp/profile-b")
		await Promise.all([session.launchBrowser(), other.launchBrowser()])
		expect(fs.readdir).not.toHaveBeenCalled()
		expect(fs.rm).not.toHaveBeenCalled()
		await session.closeBrowser()
		expect(fs.rm).toHaveBeenCalledExactlyOnceWith("/tmp/profile-a", { recursive: true, force: true })
		await other.closeBrowser()
		expect(fs.rm).toHaveBeenLastCalledWith("/tmp/profile-b", { recursive: true, force: true })
	})

	it("cleans only its own failed launch profile while another session is active", async () => {
		const other = new BrowserSession((session as any).context)
		vi.mocked(fs.mkdtemp).mockResolvedValueOnce("/tmp/profile-a").mockResolvedValueOnce("/tmp/profile-b")
		await session.launchBrowser()
		vi.mocked(launch).mockRejectedValueOnce(new Error("launch failure"))
		await expect(other.launchBrowser()).rejects.toThrow("launch failure")
		expect(fs.rm).toHaveBeenCalledExactlyOnceWith("/tmp/profile-b", { recursive: true, force: true })
		await session.closeBrowser()
		expect(fs.rm).toHaveBeenLastCalledWith("/tmp/profile-a", { recursive: true, force: true })
	})

	it.each([undefined, "chromium"])("keeps managed Chromium as the default (%s)", async (selection) => {
		settings.browserLocalBrowser = selection
		await session.launchBrowser()
		expect(PCR).toHaveBeenCalledOnce()
		expect(fs.stat).not.toHaveBeenCalled()
	})

	it.each([
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		`${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
	])("launches installed macOS Chrome at %s without a download", async (executablePath) => {
		vi.stubGlobal("process", { ...process, platform: "darwin" })
		settings.browserLocalBrowser = "chrome"
		vi.mocked(fs.stat).mockImplementation(async (candidate) => {
			if (candidate !== executablePath) throw new Error("missing")
			return { isFile: () => true } as never
		})
		await session.launchBrowser()
		expect(PCR).not.toHaveBeenCalled()
		expect(discoverChromeHostUrl).not.toHaveBeenCalled()
		expect(launch).toHaveBeenCalledWith(
			expect.objectContaining({ executablePath, userDataDir: "/tmp/roo-browser-profile-test", args: [] }),
		)
	})

	it.each(["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"])(
		"finds Windows Chrome under %s",
		async (location) => {
			vi.stubGlobal("process", { ...process, platform: "win32" })
			for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) vi.stubEnv(key, "")
			vi.stubEnv(location, "C:\\ChromeRoot")
			settings.browserLocalBrowser = "chrome"
			vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as never)
			await session.launchBrowser()
			expect(launch).toHaveBeenCalledWith(
				expect.objectContaining({ executablePath: "C:\\ChromeRoot\\Google\\Chrome\\Application\\chrome.exe" }),
			)
			expect(PCR).not.toHaveBeenCalled()
		},
	)

	it.each(["darwin", "win32", "linux"])(
		"fails explicitly for unavailable installed Chrome on %s",
		async (platform) => {
			vi.stubGlobal("process", { ...process, platform })
			settings.browserLocalBrowser = "chrome"
			vi.mocked(fs.stat).mockRejectedValue(new Error("missing"))
			await expect(session.launchBrowser()).rejects.toThrow(/select managed Chromium/i)
			expect(launch).not.toHaveBeenCalled()
			expect(PCR).not.toHaveBeenCalled()
			expect(fs.mkdtemp).not.toHaveBeenCalled()
			expect(discoverChromeHostUrl).not.toHaveBeenCalled()
		},
	)

	it("does not download or retry managed Chromium when installed Chrome cannot launch", async () => {
		vi.stubGlobal("process", { ...process, platform: "darwin" })
		settings.browserLocalBrowser = "chrome"
		vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as never)
		vi.mocked(launch).mockRejectedValueOnce(new Error("incompatible Chrome"))
		await expect(session.launchBrowser()).rejects.toThrow("sandboxed Google Chrome")
		expect(launch).toHaveBeenCalledOnce()
		expect(PCR).not.toHaveBeenCalled()
		expect(fs.rm).toHaveBeenCalledExactlyOnceWith("/tmp/roo-browser-profile-test", { recursive: true, force: true })
	})

	it("fails remote discovery without launching a local browser", async () => {
		settings.remoteBrowserEnabled = true
		await expect(session.launchBrowser()).rejects.toThrow("No local fallback")
		expect(launch).not.toHaveBeenCalled()
		expect(onStateChange).not.toHaveBeenCalled()
	})

	it("preserves remote connection and disconnect semantics", async () => {
		settings.remoteBrowserEnabled = true
		settings.browserLocalBrowser = "chrome"
		vi.mocked(discoverChromeHostUrl).mockResolvedValue("http://localhost:9222")
		vi.mocked(connect).mockResolvedValue({ disconnect } as never)
		await session.launchBrowser()
		await session.closeBrowser()
		expect(disconnect).toHaveBeenCalledOnce()
		expect(close).not.toHaveBeenCalled()
		expect(launch).not.toHaveBeenCalled()
		expect(fs.stat).not.toHaveBeenCalled()
		expect(fs.rm).not.toHaveBeenCalled()
		expect(PCR).not.toHaveBeenCalled()
	})
})
