import type { ExtensionContext } from "vscode"
import { launch } from "puppeteer-core"
// @ts-ignore - resolver does not publish types.
import PCR from "puppeteer-chromium-resolver"
import { UrlContentFetcher } from "../UrlContentFetcher"

vi.mock("puppeteer-core", () => ({ launch: vi.fn() }))
vi.mock("puppeteer-chromium-resolver", () => ({ default: vi.fn() }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(true) }))

describe("URL fetcher sandbox and lifecycle", () => {
	let fetcher: UrlContentFetcher
	const page = {
		setViewport: vi.fn(),
		setExtraHTTPHeaders: vi.fn(),
		setRequestInterception: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		goto: vi.fn(),
		url: vi.fn(),
		content: vi.fn(),
	}
	const browser = { close: vi.fn(), newPage: vi.fn() }
	beforeEach(() => {
		vi.resetAllMocks()
		fetcher = new UrlContentFetcher({ globalStorageUri: { fsPath: "/storage" } } as ExtensionContext)
		vi.mocked(PCR).mockResolvedValue({ executablePath: "/chromium", puppeteer: { launch } })
		vi.mocked(launch).mockResolvedValue(browser as never)
		browser.newPage.mockResolvedValue(page)
		browser.close.mockResolvedValue(undefined)
		page.setRequestInterception.mockResolvedValue(undefined)
		page.url.mockReturnValue("https://example.com")
		page.content.mockResolvedValue("<p>Web content</p>")
	})
	afterEach(() => vi.unstubAllGlobals())

	it.each(["linux", "darwin", "win32"])("preserves the sandbox on %s", async (platform) => {
		vi.stubGlobal("process", { ...process, platform, getuid: () => 0 })
		await fetcher.launchBrowser()
		const options = vi.mocked(launch).mock.calls[0][0]!
		expect(options.args).not.toContain("--no-sandbox")
		expect(options.args).not.toContain("--disable-setuid-sandbox")
		expect(await fetcher.urlToMarkdown("https://example.com")).toBe("Web content")
		await fetcher.dispose()
		expect(browser.close).toHaveBeenCalledOnce()
	})
	it("reports sandbox failures without insecure retries", async () => {
		vi.mocked(launch).mockRejectedValue(new Error("No usable sandbox"))
		await expect(fetcher.launchBrowser()).rejects.toThrow(/non-root.*AppArmor.*No sandbox-disabled fallback/)
		expect(launch).toHaveBeenCalledOnce()
		expect(browser.newPage).not.toHaveBeenCalled()
		await fetcher.closeBrowser()
	})
	it.each(["newPage", "setViewport", "setExtraHTTPHeaders", "setRequestInterception"])(
		"cleans up failed %s initialization",
		async (step) => {
			const operation = step === "newPage" ? browser.newPage : page[step as keyof typeof page]
			operation.mockRejectedValueOnce(new Error("setup failed"))
			await expect(fetcher.launchBrowser()).rejects.toThrow("setup failed")
			expect(browser.close).toHaveBeenCalledOnce()
			await fetcher.closeBrowser()
			expect(browser.close).toHaveBeenCalledOnce()
			await fetcher.launchBrowser()
			expect(launch).toHaveBeenCalledTimes(2)
		},
	)
	it("serializes duplicate launches and a pending close", async () => {
		let finish!: (value: any) => void
		vi.mocked(launch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const first = fetcher.launchBrowser()
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
		const second = fetcher.launchBrowser()
		const closing = fetcher.closeBrowser()
		finish(browser)
		await Promise.all([first, second, closing])
		expect(launch).toHaveBeenCalledOnce()
		expect(browser.close).toHaveBeenCalledOnce()
		await fetcher.launchBrowser()
		expect(launch).toHaveBeenCalledTimes(2)
	})
	it("waits for and closes a pending launch after permanent disposal", async () => {
		let finish!: (value: any) => void
		vi.mocked(launch).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const launching = fetcher.launchBrowser()
		const rejected = expect(launching).rejects.toThrow("disposed")
		await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce())
		const disposing = fetcher.dispose()
		expect(fetcher.dispose()).toBe(disposing)
		finish(browser)
		await rejected
		await disposing
		expect(browser.newPage).not.toHaveBeenCalled()
		expect(browser.close).toHaveBeenCalledOnce()
		await expect(fetcher.launchBrowser()).rejects.toThrow("disposed")
		expect(launch).toHaveBeenCalledOnce()
	})
	it("refuses non-web committed URLs before reading page content", async () => {
		await fetcher.launchBrowser()
		page.url.mockReturnValue("file:///private/test")
		await expect(fetcher.urlToMarkdown("https://example.com")).rejects.toThrow(/HTTP/)
		expect(page.content).not.toHaveBeenCalled()
	})
})
