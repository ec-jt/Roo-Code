import type { ExtensionContext } from "vscode"
import { launch } from "puppeteer-core"
// @ts-expect-error The resolver does not publish types.
import PCR from "puppeteer-chromium-resolver"
import { UrlContentFetcher } from "../../../services/browser/UrlContentFetcher"
import { fetchPdfUrl } from "../../../services/browser/pdfContent"

vi.mock("puppeteer-core", () => ({ launch: vi.fn() }))
vi.mock("puppeteer-chromium-resolver", () => ({ default: vi.fn() }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(true) }))
vi.mock("../../../services/browser/pdfContent", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/browser/pdfContent")>()),
	fetchPdfUrl: vi.fn(),
}))

describe("PDF URL-to-Markdown dispatch", () => {
	const page = {
		setViewport: vi.fn(),
		setExtraHTTPHeaders: vi.fn(),
		setRequestInterception: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		goto: vi.fn(),
		content: vi.fn(),
	}
	const browser = { close: vi.fn(), newPage: vi.fn() }
	let fetcher: UrlContentFetcher
	beforeEach(() => {
		vi.resetAllMocks()
		fetcher = new UrlContentFetcher({ globalStorageUri: { fsPath: "/storage" } } as ExtensionContext)
		vi.mocked(PCR).mockResolvedValue({ executablePath: "/chromium", puppeteer: { launch } })
		vi.mocked(launch).mockResolvedValue(browser as never)
		browser.newPage.mockResolvedValue(page)
		browser.close.mockResolvedValue(undefined)
		vi.mocked(fetchPdfUrl).mockResolvedValue({ text: "PDF text", pages: 1, pagesRead: 1, truncated: false })
	})
	it("reads explicit PDFs without launching Chromium", async () => {
		const signal = new AbortController().signal
		expect(await fetcher.fetchMarkdown("https://example.com/paper.pdf", signal)).toBe("PDF text")
		expect(fetchPdfUrl).toHaveBeenCalledWith("https://example.com/paper.pdf", { signal })
		expect(launch).not.toHaveBeenCalled()
	})
	it("handles a PDF MIME response without scraping the viewer", async () => {
		page.goto.mockResolvedValue({
			headers: () => ({ "content-type": "application/pdf" }),
			url: () => "https://example.com/download",
		})
		expect(await fetcher.fetchMarkdown("https://example.com/download", new AbortController().signal)).toBe(
			"PDF text",
		)
		expect(page.content).not.toHaveBeenCalled()
		expect(browser.close).toHaveBeenCalledOnce()
		expect(page.off).toHaveBeenCalledWith("response", expect.any(Function))
	})
	it("does not fall back to viewer scraping if native parsing fails", async () => {
		page.goto.mockResolvedValue({
			headers: () => ({ "content-type": "application/pdf" }),
			url: () => "https://example.com/download",
		})
		vi.mocked(fetchPdfUrl).mockRejectedValue(new Error("Response is not a PDF"))
		await expect(
			fetcher.fetchMarkdown("https://example.com/download", new AbortController().signal),
		).rejects.toThrow(/not a PDF/)
		expect(page.content).not.toHaveBeenCalled()
		expect(browser.close).toHaveBeenCalledOnce()
	})
})
