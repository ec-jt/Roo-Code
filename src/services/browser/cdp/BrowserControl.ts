import { randomUUID } from "crypto"
import type { Browser, Page, ElementHandle, Frame, ConsoleMessage, HTTPRequest, HTTPResponse } from "puppeteer-core"
import {
	browserControlCommandSchema,
	type BrowserControlCommand,
	type BrowserControlResult,
	type BrowserControlState,
	type BrowserControlConsoleEntry,
	type BrowserControlNetworkEntry,
} from "../../../../packages/types/src/browser-control"
import { validateWebUrl } from "../validateWebUrl"
import { ControlError, controlError, sanitizeBrowserUrl } from "./controlSecurity"

const WARNING =
	"Page DOM, console text, and URL paths may contain secrets or untrusted instructions. Do not persist or log these payloads."
const CAPABILITIES: BrowserControlState["capabilities"] = {
	status: true,
	tabs: true,
	select_tab: true,
	navigate: true,
	snapshot: true,
	click_ref: true,
	fill_ref: true,
	select_ref: true,
	wait: true,
	console: true,
	network: true,
	inspect: true,
	styles: true,
	performance: true,
	evaluate: false,
	response_body: false,
	debugger: false,
	certificate_exception: false,
}

export interface BrowserControlHost {
	getBrowser(): Browser | undefined
	isAttached(): boolean
	isOwnedPage(page: Page): boolean
	newPage(): Promise<Page>
	selectPage(page: Page): void
	guardPage(page: Page): Promise<void>
	releasePage(page: Page): Promise<void>
	getCertificatePolicy?(): BrowserControlState["certificatePolicy"]
	extensionHost: BrowserControlState["extensionHost"]
}

/** All calls must run on BrowserSession's lifecycle queue, never a second nested queue. */
export class BrowserControl {
	private sessionId = randomUUID()
	private browser?: Browser
	private selected?: Page
	private generation = 0
	private tabs = new Map<string, Page>()
	private refs = new Map<string, ElementHandle<Element>>()
	private console: BrowserControlConsoleEntry[] = []
	private network: BrowserControlNetworkEntry[] = []
	private requestIds = new WeakMap<HTTPRequest, string>()
	private unsubscribe?: () => void
	private cleanup: Promise<void> = Promise.resolve()
	private poisoned = false
	private epoch = 0
	private readonly disconnected = () => {
		this.poisoned = true
		this.clearSelection()
	}

	constructor(private readonly host: BrowserControlHost) {}

	getState(): BrowserControlState {
		this.bindBrowser()
		return {
			sessionId: this.sessionId,
			connected: !!this.host.getBrowser()?.connected && !this.poisoned,
			tabId: this.selected ? this.tabId(this.selected) : undefined,
			generation: this.generation,
			transport: "cdp",
			ownership: this.host.getBrowser() ? (this.host.isAttached() ? "attached" : "roo-owned") : "none",
			extensionHost: this.host.extensionHost,
			certificatePolicy: this.host.getCertificatePolicy?.() ?? "verify",
			capabilities: { ...CAPABILITIES },
		}
	}

	private bindBrowser(): void {
		const browser = this.host.getBrowser()
		if (this.browser === browser) return
		this.browser?.off("disconnected", this.disconnected)
		this.clearSelection()
		this.tabs.clear()
		this.browser = browser
		this.sessionId = randomUUID()
		this.poisoned = false
		browser?.on("disconnected", this.disconnected)
	}

	async dispose(): Promise<void> {
		this.clearSelection()
		this.browser?.off("disconnected", this.disconnected)
		this.browser = undefined
		this.tabs.clear()
		this.sessionId = randomUUID()
		await this.cleanup
	}

	private invalidateRefs(): void {
		this.generation++
		for (const handle of this.refs.values()) void handle.dispose().catch(() => {})
		this.refs.clear()
	}

	private clearSelection(): void {
		const page = this.selected
		this.epoch++
		this.unsubscribe?.()
		this.unsubscribe = undefined
		this.selected = undefined
		this.invalidateRefs()
		this.console = []
		this.network = []
		this.requestIds = new WeakMap()
		if (page) this.cleanup = this.cleanup.then(() => this.host.releasePage(page)).catch(() => {})
	}

	/** Legacy controls are separately authorized and must not retain a rich-control selection. */
	async suspendForLegacyAction(): Promise<void> {
		this.clearSelection()
		await this.cleanup
	}

	private tabId(page: Page): string {
		for (const [id, candidate] of this.tabs) if (candidate === page) return id
		const id = randomUUID()
		this.tabs.set(id, page)
		return id
	}

	private allowed(page: Page): boolean {
		if (page.isClosed()) return false
		if (page.url() === "about:blank") return this.host.isOwnedPage(page)
		try {
			validateWebUrl(page.url())
			return true
		} catch {
			return false
		}
	}

	private assertCurrent(epoch: number, page?: Page): void {
		if (epoch !== this.epoch || this.poisoned || !this.browser?.connected) {
			throw new ControlError(
				"disconnected",
				"Control was detached or timed out. No action was retried; relaunch or reconnect explicitly.",
			)
		}
		if (page && (!this.allowed(page) || page !== this.selected)) {
			throw new ControlError(
				"unauthorized_page",
				"Select an authorized HTTP(S) tab before reading or interacting with it.",
			)
		}
	}

	private async select(page: Page, epoch: number): Promise<void> {
		this.assertCurrent(epoch)
		if (!this.allowed(page))
			throw new ControlError("unauthorized_page", "Only HTTP(S) pages or Roo-owned blank tabs can be selected.")
		const previous = this.selected
		if (previous === page) return
		this.clearSelection()
		const selectionEpoch = this.epoch
		await this.cleanup
		this.assertCurrent(selectionEpoch)
		await this.host.guardPage(page)
		try {
			this.assertCurrent(selectionEpoch)
			if (!this.allowed(page)) throw new ControlError("unauthorized_page", "The tab navigated outside HTTP(S).")
		} catch (error) {
			await this.host.releasePage(page).catch(() => {})
			throw error
		}
		this.selected = page
		this.host.selectPage(page)
		this.tabId(page)
		const onNavigation = (_frame: Frame) => {
			this.invalidateRefs()
			// Keep metadata across web navigations, but never capture a privileged page.
			if (!this.allowed(page)) this.clearSelection()
		}
		const onClose = () => this.clearSelection()
		const onConsole = (message: ConsoleMessage) => {
			if (this.selected !== page || !this.allowed(page)) return
			this.console.push({
				time: Date.now(),
				level: message.type().slice(0, 30),
				text: message.text().slice(0, 1000),
			})
			if (this.console.length > 50) this.console.shift()
		}
		const onRequest = (request: HTTPRequest) => {
			if (this.selected !== page || !this.allowed(page)) return
			const requestId = randomUUID()
			this.requestIds.set(request, requestId)
			this.network.push({
				requestId,
				url: sanitizeBrowserUrl(request.url()),
				method: request.method().slice(0, 20),
			})
			if (this.network.length > 50) this.network.shift()
		}
		const onResponse = (response: HTTPResponse) => {
			const entry = this.network.find((item) => item.requestId === this.requestIds.get(response.request()))
			if (entry) entry.status = response.status()
		}
		const onFailed = (request: HTTPRequest) => {
			const entry = this.network.find((item) => item.requestId === this.requestIds.get(request))
			if (entry) entry.failed = true
		}
		page.on("framenavigated", onNavigation)
		page.on("close", onClose)
		page.on("console", onConsole)
		page.on("request", onRequest)
		page.on("response", onResponse)
		page.on("requestfailed", onFailed)
		this.unsubscribe = () => {
			page.off("framenavigated", onNavigation)
			page.off("close", onClose)
			page.off("console", onConsole)
			page.off("request", onRequest)
			page.off("response", onResponse)
			page.off("requestfailed", onFailed)
		}
	}

	async control(input: BrowserControlCommand): Promise<BrowserControlResult> {
		this.bindBrowser()
		const parsed = browserControlCommandSchema.safeParse(input)
		if (!parsed.success)
			return {
				ok: false,
				action: "invalid",
				state: this.getState(),
				warnings: [],
				error: {
					category: "invalid_command",
					message:
						"Invalid browser command or unsupported fields. Check the strict command schema and limits.",
				},
			}
		const command = parsed.data
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			if (!CAPABILITIES[command.action])
				throw new ControlError(
					"unsupported",
					"This command is not supported. Evaluation and response bodies require separate per-call approval and safe bounded acquisition; no raw CDP escape is available.",
				)
			const data = await Promise.race([
				this.execute(command),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => {
							this.poisoned = true
							this.clearSelection()
							reject(new Error("Browser control timed out"))
						},
						"timeoutMs" in command ? (command.timeoutMs ?? 10_000) : 10_000,
					)
				}),
			])
			return { ok: true, action: command.action, state: this.getState(), warnings: [WARNING], data }
		} catch (error) {
			const diagnostic = controlError(error)
			if (diagnostic.category === "disconnected" || diagnostic.category === "timeout") {
				this.poisoned = true
				this.clearSelection()
			}
			return { ok: false, action: command.action, state: this.getState(), warnings: [WARNING], error: diagnostic }
		} finally {
			clearTimeout(timer)
		}
	}

	private async execute(command: BrowserControlCommand): Promise<BrowserControlResult["data"]> {
		if (command.action === "status") return undefined
		if (!this.browser?.connected || this.poisoned)
			throw new ControlError("not_connected", "Launch or reconnect the browser explicitly before using controls.")
		let epoch = this.epoch
		if (command.action === "tabs") {
			const pages = await this.browser.pages()
			this.assertCurrent(epoch)
			for (const [id, page] of this.tabs) if (!pages.includes(page)) this.tabs.delete(id)
			const allowed = pages.filter((page) => this.allowed(page))
			return {
				tabs: allowed.slice(0, 100).map((page) => ({
					id: this.tabId(page),
					url: page.url() === "about:blank" ? "about:blank" : sanitizeBrowserUrl(page.url()),
					selected: page === this.selected,
					owned: this.host.isOwnedPage(page),
				})),
				truncated: allowed.length > 100,
			}
		}
		if ("sessionId" in command && command.sessionId !== this.sessionId)
			throw new ControlError("stale_reference", "Session ID is stale. Read status and tabs again.")
		if (command.action === "select_tab") {
			const page = this.tabs.get(command.tabId)
			if (!page) throw new ControlError("stale_reference", "Tab ID is stale or unknown. List tabs again.")
			await this.select(page, epoch)
			return { url: sanitizeBrowserUrl(page.url()) }
		}
		if (command.action === "navigate") {
			validateWebUrl(command.url)
			if (!this.selected) {
				const page = await this.host.newPage()
				this.assertCurrent(epoch)
				await this.select(page, epoch)
			}
			const page = this.selected!
			epoch = this.epoch
			this.assertCurrent(epoch, page)
			this.invalidateRefs()
			await page.goto(command.url, { waitUntil: "domcontentloaded", timeout: command.timeoutMs ?? 10_000 })
			this.assertCurrent(epoch, page)
			return { url: sanitizeBrowserUrl(page.url()) }
		}
		const page = this.selected
		if (!page || !("tabId" in command) || this.tabs.get(command.tabId) !== page)
			throw new ControlError("stale_reference", "Explicitly select the tab first; the selected tab has changed.")
		this.assertCurrent(epoch, page)
		if (command.action === "snapshot") return this.snapshot(page, command.limit ?? 50, epoch)
		if (command.action === "console") {
			const entries = [...this.console]
			if (command.clear) this.console = []
			return { console: entries }
		}
		if (command.action === "network") {
			const entries = this.network.map((entry) => ({ ...entry }))
			if (command.clear) this.network = []
			return { network: entries }
		}
		if (command.action === "wait") {
			await new Promise((resolve) => setTimeout(resolve, command.durationMs))
			this.assertCurrent(epoch, page)
			return undefined
		}
		if (command.action === "performance") {
			const metrics = await page.metrics()
			this.assertCurrent(epoch, page)
			return {
				metrics: Object.fromEntries(
					Object.entries(metrics)
						.filter(([, value]) => typeof value === "number" && Number.isFinite(value))
						.slice(0, 30),
				),
			}
		}
		if (!("ref" in command)) throw new ControlError("unsupported", "Command is not supported.")
		const handle = this.refs.get(command.ref)
		if (!handle)
			throw new ControlError(
				"stale_reference",
				"Element reference is stale. Take a new snapshot after navigation or tab selection.",
			)
		const generation = this.generation
		const connected = await handle.evaluate((element) => element.isConnected)
		this.assertCurrent(epoch, page)
		if (!connected || generation !== this.generation)
			throw new ControlError(
				"stale_reference",
				"Element is detached or the document changed. Take a new snapshot.",
			)
		switch (command.action) {
			case "click_ref":
				await handle.click()
				break
			case "fill_ref":
				await handle.evaluate((element, text) => {
					if (
						!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) ||
						(element instanceof HTMLInputElement &&
							["file", "hidden", "checkbox", "radio", "submit", "button"].includes(element.type)) ||
						element.disabled ||
						element.readOnly
					)
						throw new Error("Element is not editable")
					element.focus()
					const prototype =
						element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
					Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, text)
					element.dispatchEvent(new Event("input", { bubbles: true }))
					element.dispatchEvent(new Event("change", { bubbles: true }))
				}, command.text)
				break
			case "select_ref":
				await handle.select(...command.values)
				break
			case "inspect": {
				const inspection = await describeElement(handle)
				this.assertCurrent(epoch, page)
				if (generation !== this.generation)
					throw new ControlError("stale_reference", "Document changed during inspection.")
				return { inspection }
			}
			case "styles": {
				const styles = await handle.evaluate((element, properties) => {
					const style = getComputedStyle(element)
					return Object.fromEntries(
						properties.map((name) => [name, style.getPropertyValue(name).slice(0, 500)]),
					)
				}, command.properties)
				this.assertCurrent(epoch, page)
				if (generation !== this.generation)
					throw new ControlError("stale_reference", "Document changed during inspection.")
				return { styles }
			}
		}
		this.assertCurrent(epoch, page)
		return undefined
	}

	private async snapshot(page: Page, limit: number, epoch: number): Promise<BrowserControlResult["data"]> {
		this.invalidateRefs()
		const generation = this.generation
		// Return at most 100 remote handles, not an unbounded DOM/AX tree or HTML string.
		const list = await page.evaluateHandle((max) => {
			const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
			const elements: Element[] = []
			let node: Node | null = walker.currentNode
			let scanned = 0
			while (node && scanned++ < 5000 && elements.length < max) {
				const element = node as Element
				if (element.matches("a[href],button,input,textarea,select,[role],[tabindex],h1,h2,h3"))
					elements.push(element)
				node = walker.nextNode()
			}
			return elements
		}, limit)
		try {
			const properties = await list.getProperties()
			const elements: NonNullable<BrowserControlResult["data"]>["elements"] = []
			try {
				for (const handle of properties.values()) {
					this.assertCurrent(epoch, page)
					if (generation !== this.generation)
						throw new ControlError(
							"stale_reference",
							"Document changed while snapshotting. Take a new snapshot.",
						)
					const element = handle.asElement() as ElementHandle<Element> | null
					if (!element) continue
					const description = await describeElement(element)
					this.assertCurrent(epoch, page)
					if (generation !== this.generation)
						throw new ControlError(
							"stale_reference",
							"Document changed while snapshotting. Take a new snapshot.",
						)
					const ref = randomUUID()
					this.refs.set(ref, element)
					const { connected: _connected, ...summary } = description
					elements.push({ ref, ...summary })
				}
				return { elements, truncated: true }
			} finally {
				const retained = new Set(this.refs.values())
				for (const handle of properties.values())
					if (!retained.has(handle as ElementHandle<Element>)) void handle.dispose().catch(() => {})
			}
		} finally {
			void list.dispose().catch(() => {})
		}
	}
}

async function describeElement(handle: ElementHandle<Element>) {
	return handle.evaluate((element) => ({
		tag: element.tagName.slice(0, 50).toLowerCase(),
		role: (element.getAttribute("role") ?? "").slice(0, 80),
		name: (element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? element.textContent ?? "").slice(
			0,
			256,
		),
		type: (element.getAttribute("type") ?? "").slice(0, 50),
		connected: element.isConnected,
	}))
}
