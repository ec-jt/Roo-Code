import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import { Browser, Page, launch } from "puppeteer-core"
import * as cheerio from "cheerio"
import TurndownService from "turndown"
// @ts-ignore
import PCR from "puppeteer-chromium-resolver"
import { fileExistsAtPath } from "../../utils/fs"
import { serializeError } from "serialize-error"
import { validateWebUrl } from "./validateWebUrl"
import { BrowserLifecycle } from "./BrowserLifecycle"
import { browserLaunchError } from "./browserLaunchError"
import { restrictWebNavigation, validatePageUrl } from "./webNavigation"

// Timeout constants
const URL_FETCH_TIMEOUT = 30_000 // 30 seconds
const URL_FETCH_FALLBACK_TIMEOUT = 20_000 // 20 seconds for fallback

interface PCRStats {
	puppeteer: { launch: typeof launch }
	executablePath: string
}

export class UrlContentFetcher {
	private context: vscode.ExtensionContext
	private browser?: Browser
	private page?: Page
	private readonly lifecycle = new BrowserLifecycle()
	private removeNavigationGuard?: () => Promise<void>

	constructor(context: vscode.ExtensionContext) {
		this.context = context
	}

	private async ensureChromiumExists(): Promise<PCRStats> {
		const globalStoragePath = this.context?.globalStorageUri?.fsPath
		if (!globalStoragePath) {
			throw new Error("Global storage uri is invalid")
		}
		const puppeteerDir = path.join(globalStoragePath, "puppeteer")
		const dirExists = await fileExistsAtPath(puppeteerDir)
		if (!dirExists) {
			await fs.mkdir(puppeteerDir, { recursive: true })
		}
		// if chromium doesn't exist, this will download it to path.join(puppeteerDir, ".chromium-browser-snapshots")
		// if it does exist it will return the path to existing chromium
		const stats: PCRStats = await PCR({
			downloadPath: puppeteerDir,
		})
		return stats
	}

	launchBrowser(): Promise<void> {
		return this.lifecycle.run(() => this.launchBrowserNow())
	}

	private async launchBrowserNow(): Promise<void> {
		this.lifecycle.assertOpen()
		if (this.browser) {
			return
		}
		const stats = await this.ensureChromiumExists()
		const args = [
			"--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
			"--disable-dev-shm-usage",
			"--disable-accelerated-2d-canvas",
			"--no-first-run",
			"--disable-gpu",
			"--disable-features=VizDisplayCompositor",
		]
		try {
			this.lifecycle.assertOpen()
			const browser = await stats.puppeteer.launch({ args, executablePath: stats.executablePath })
			try {
				this.lifecycle.assertOpen()
			} catch (error) {
				await browser.close().catch(() => {})
				throw error
			}
			this.browser = browser
			this.page = await browser.newPage()
			this.removeNavigationGuard = await restrictWebNavigation(this.page)
			await this.page.setViewport({ width: 1280, height: 720 })
			await this.page.setExtraHTTPHeaders({
				"Accept-Language": "en-US,en;q=0.9",
			})
			this.lifecycle.assertOpen()
		} catch (error) {
			await this.closeBrowserNow()
			throw browserLaunchError(error, "Chromium for URL content fetching")
		}
	}

	closeBrowser(): Promise<void> {
		return this.lifecycle.run(() => this.closeBrowserNow())
	}

	dispose(): Promise<void> {
		return this.lifecycle.dispose(() => this.closeBrowserNow())
	}

	private async closeBrowserNow(): Promise<void> {
		await this.removeNavigationGuard?.().catch(() => {})
		this.removeNavigationGuard = undefined
		await this.browser?.close().catch(() => {})
		this.browser = undefined
		this.page = undefined
	}

	// must make sure to call launchBrowser before and closeBrowser after using this
	async urlToMarkdown(url: string): Promise<string> {
		validateWebUrl(url)
		return this.lifecycle.run(() => this.urlToMarkdownNow(url))
	}

	private async urlToMarkdownNow(url: string): Promise<string> {
		this.lifecycle.assertOpen()
		if (!this.browser || !this.page) {
			throw new Error("Browser not initialized")
		}
		/*
		- In Puppeteer, "networkidle2" waits until there are no more than 2 network connections for at least 500 ms (roughly equivalent to Playwright's "networkidle").
		- "domcontentloaded" is when the basic DOM is loaded.
		This should be sufficient for most doc sites.
		*/
		try {
			await this.page.goto(url, {
				timeout: URL_FETCH_TIMEOUT,
				waitUntil: ["domcontentloaded", "networkidle2"],
			})
		} catch (error) {
			// Use serialize-error to safely extract error information
			const serializedError = serializeError(error)
			const errorMessage = serializedError.message || String(error)
			const errorName = serializedError.name

			// Only retry for timeout or network-related errors
			const shouldRetry =
				errorMessage.includes("timeout") ||
				errorMessage.includes("net::") ||
				errorMessage.includes("NetworkError") ||
				errorMessage.includes("ERR_") ||
				errorName === "TimeoutError"

			if (shouldRetry) {
				// If networkidle2 fails due to timeout/network issues, try with just domcontentloaded as fallback
				console.warn(
					`Failed to load ${url} with networkidle2, retrying with domcontentloaded only: ${errorMessage}`,
				)
				await this.page.goto(url, {
					timeout: URL_FETCH_FALLBACK_TIMEOUT,
					waitUntil: ["domcontentloaded"],
				})
			} else {
				// For other errors, throw them as-is
				throw error
			}
		}

		validatePageUrl(this.page)
		const content = await this.page.content()

		// use cheerio to parse and clean up the HTML
		const $ = cheerio.load(content)
		$("script, style, nav, footer, header").remove()

		// convert cleaned HTML to markdown
		const turndownService = new TurndownService()
		const markdown = turndownService.turndown($.html())

		return markdown
	}
}
