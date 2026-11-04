import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { Socket } from "node:net"
import { z } from "zod"
import {
	browserControlCommandSchema,
	type BrowserControlCommand,
	type BrowserControlResult,
	type BrowserControlState,
} from "../../../../packages/types/src/browser-control"
import { sanitizeBrowserUrl } from "../cdp/controlSecurity"

const id = z.string().uuid()
const webUrl = z
	.string()
	.max(2000)
	.url()
	.refine((url) => /^https?:\/\//.test(url))
const document = { documentId: id, url: webUrl }
const envelope = { clientId: id, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }
const element = z
	.object({
		ref: id,
		tag: z.string().max(80),
		role: z.string().max(80),
		name: z.string().max(256),
		type: z.string().max(80),
	})
	.strict()
const data = z
	.object({
		elements: z.array(element).max(100).optional(),
		truncated: z.boolean().optional(),
		inspection: element.omit({ ref: true }).extend({ connected: z.boolean() }).strict().optional(),
	})
	.strict()
const pair = z.object({ ...envelope, ...document, tabId: id }).strict()
const poll = z.object({ ...envelope, ...document }).strict()
const result = z
	.object({
		...envelope,
		...document,
		requestId: id,
		ok: z.boolean(),
		data: data.optional(),
		error: z.enum(["stale_reference", "operation_failed"]).optional(),
	})
	.strict()
const revoke = z.object(envelope).strict()
const MAX_BYTES = 128 * 1024

export const BRIDGE_CAPABILITIES: BrowserControlState["capabilities"] = {
	status: true,
	tabs: true,
	select_tab: true,
	snapshot: true,
	inspect: true,
	wait: true,
	navigate: false,
	click_ref: false,
	fill_ref: false,
	select_ref: false,
	console: false,
	network: false,
	styles: false,
	performance: false,
	evaluate: false,
	response_body: false,
	debugger: false,
	certificate_exception: false,
}

/** Ephemeral native-user-started listener. Credentials must never be included in control state/results. */
export class BrowserExtensionBridge {
	private server?: Server
	private sockets = new Set<Socket>()
	private secret = ""
	private origin = ""
	private host = ""
	private sessionId = randomUUID()
	private generation = 0
	private clientId?: string
	private tabId?: string
	private documentId?: string
	private url = ""
	private sequence = 0
	private selected = false
	private deadline = 0
	private lastSeen = 0
	private rateWindow = 0
	private requestsInWindow = 0
	private timer?: ReturnType<typeof setInterval>
	private pending?: {
		id: string
		documentId: string
		command: BrowserControlCommand
		sent: boolean
		resolve: (result: BrowserControlResult) => void
		timer: ReturnType<typeof setTimeout>
	}
	constructor(private readonly extensionHost: BrowserControlState["extensionHost"]) {}

	getState(): BrowserControlState {
		return {
			sessionId: this.sessionId,
			generation: this.generation,
			connected: !!this.clientId,
			tabId: this.selected ? this.tabId : undefined,
			transport: "chrome-extension",
			ownership: this.clientId ? "attached" : "none",
			extensionHost: this.extensionHost,
			certificatePolicy: "verify",
			capabilities: { ...BRIDGE_CAPABILITIES },
		}
	}

	/** Return value is for a native VS Code dialog only. Never persist, log, or send it to a webview. */
	async start(extensionId: string): Promise<{ endpoint: string; secret: string }> {
		if (!/^[a-p]{32}$/.test(extensionId) || this.server)
			throw new Error("Invalid extension ID or bridge already started.")
		this.origin = `chrome-extension://${extensionId}`
		this.secret = randomBytes(32).toString("hex")
		this.deadline = Date.now() + 120_000
		const server = createServer({ maxHeaderSize: 4096, requestTimeout: 3000, headersTimeout: 3000 }, (req, res) => {
			const deadline = setTimeout(() => req.destroy(), 3000)
			void this.handle(req, res)
				.catch(() => {
					if (!res.destroyed) res.destroy()
				})
				.finally(() => clearTimeout(deadline))
		})
		this.server = server
		server.keepAliveTimeout = 1000
		server.maxRequestsPerSocket = 100
		server.on("connection", (socket) => {
			if (this.sockets.size >= 8) {
				socket.destroy()
				return
			}
			this.sockets.add(socket)
			socket.setTimeout(3000, () => socket.destroy())
			socket.on("close", () => this.sockets.delete(socket))
		})
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(0, "127.0.0.1", () => {
				server.removeListener("error", reject)
				resolve()
			})
		}).catch(() => {
			this.stop()
			throw new Error("Could not start the loopback bridge.")
		})
		server.on("error", () => this.stop())
		const address = server.address()
		if (!address || typeof address === "string") {
			this.stop()
			throw new Error("Bridge listener unavailable.")
		}
		this.host = `127.0.0.1:${address.port}`
		this.timer = setInterval(() => {
			if (Date.now() > this.deadline || (this.clientId && Date.now() - this.lastSeen > 10_000)) this.stop()
		}, 1000)
		this.timer.unref()
		return { endpoint: `http://${this.host}`, secret: this.secret }
	}

	stop(): void {
		clearInterval(this.timer)
		this.timer = undefined
		this.secret = ""
		this.clientId = undefined
		this.tabId = undefined
		this.documentId = undefined
		this.selected = false
		this.generation++
		this.sessionId = randomUUID()
		if (this.pending) {
			const pending = this.pending
			this.pending = undefined
			clearTimeout(pending.timer)
			pending.resolve(
				this.failure(
					pending.command.action,
					"disconnected",
					"Bridge revoked or disconnected. No command was retried.",
				),
			)
		}
		this.server?.close()
		this.server = undefined
		for (const socket of this.sockets) socket.destroy()
		this.sockets.clear()
	}

	private failure(
		action: BrowserControlResult["action"],
		category: NonNullable<BrowserControlResult["error"]>["category"],
		message: string,
	): BrowserControlResult {
		return { ok: false, action, state: this.getState(), warnings: [], error: { category, message } }
	}

	async control(input: BrowserControlCommand): Promise<BrowserControlResult> {
		const parsed = browserControlCommandSchema.safeParse(input)
		if (!parsed.success) return this.failure("invalid", "invalid_command", "Invalid browser command.")
		const command = parsed.data
		if (!BRIDGE_CAPABILITIES[command.action])
			return this.failure(
				command.action,
				"unsupported",
				"This command is unavailable on the Chrome extension transport.",
			)
		const success = (data?: BrowserControlResult["data"]): BrowserControlResult => ({
			ok: true,
			action: command.action,
			state: this.getState(),
			warnings: [],
			data,
		})
		if (command.action === "status") return success()
		if (!this.clientId)
			return this.failure(
				command.action,
				"not_connected",
				"Explicitly pair and attach a tab in the Chrome popup first.",
			)
		if (command.action === "tabs")
			return success({ tabs: [{ id: this.tabId!, url: this.url, selected: this.selected, owned: false }] })
		if (!("sessionId" in command) || command.sessionId !== this.sessionId || command.tabId !== this.tabId)
			return this.failure(command.action, "stale_reference", "Session or attached tab changed.")
		if (command.action === "select_tab") {
			this.selected = true
			this.generation++
			return success()
		}
		if (!this.selected)
			return this.failure(command.action, "unauthorized_page", "Select the attached tab before reading it.")
		if (this.pending) return this.failure(command.action, "operation_failed", "Another command is pending.")
		return new Promise((resolve) => {
			this.pending = {
				id: randomUUID(),
				documentId: this.documentId!,
				command,
				sent: false,
				resolve,
				timer: setTimeout(() => this.stop(), command.timeoutMs ?? 10_000),
			}
		})
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const reply = (status: number, body: unknown = {}) => {
			res.writeHead(status, {
				"Content-Type": "application/json",
				"Cache-Control": "no-store",
				Connection: "close",
			})
			res.end(JSON.stringify(body))
		}
		if (Date.now() - this.rateWindow > 1000) {
			this.rateWindow = Date.now()
			this.requestsInWindow = 0
		}
		if (++this.requestsInWindow > 40) {
			reply(429)
			return
		}
		// No wildcard, reflected origin, DNS names, URL credentials, or remote bind.
		if (req.headers.host !== this.host || req.headers.origin !== this.origin || !this.secret) {
			reply(403)
			return
		}
		res.setHeader("Access-Control-Allow-Origin", this.origin)
		res.setHeader("Vary", "Origin")
		if (req.method === "OPTIONS") {
			if (req.headers["access-control-request-method"] !== "POST") {
				reply(403)
				return
			}
			const headers = String(req.headers["access-control-request-headers"] ?? "")
				.toLowerCase()
				.split(",")
				.map((v) => v.trim())
			if (headers.some((v) => !["authorization", "content-type"].includes(v))) {
				reply(403)
				return
			}
			res.setHeader("Access-Control-Allow-Methods", "POST")
			res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
			reply(204)
			return
		}
		const auth = req.headers.authorization ?? ""
		const expected = `Bearer ${this.secret}`
		const sessionId = this.sessionId
		if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) {
			reply(403)
			return
		}
		if (Date.now() > this.deadline || req.method !== "POST" || req.headers["content-type"] !== "application/json") {
			reply(403)
			return
		}
		if (Number(req.headers["content-length"]) > MAX_BYTES) {
			reply(413)
			return
		}
		let bytes = 0
		const chunks: Buffer[] = []
		for await (const chunk of req) {
			bytes += chunk.length
			if (bytes > MAX_BYTES) {
				reply(413)
				return
			}
			chunks.push(chunk)
		}
		if (!this.secret || this.sessionId !== sessionId || Date.now() > this.deadline) {
			reply(403)
			return
		}
		let raw: unknown
		try {
			raw = JSON.parse(Buffer.concat(chunks).toString("utf8"))
		} catch {
			reply(400)
			return
		}
		const schema =
			req.url === "/pair"
				? pair.transform((value) => ({ ...value, kind: "pair" as const }))
				: req.url === "/poll"
					? poll.transform((value) => ({ ...value, kind: "poll" as const }))
					: req.url === "/result"
						? result.transform((value) => ({ ...value, kind: "result" as const }))
						: req.url === "/revoke"
							? revoke.transform((value) => ({ ...value, kind: "revoke" as const }))
							: undefined
		const parsed = schema?.safeParse(raw)
		if (!parsed?.success) {
			reply(400)
			return
		}
		const message = parsed.data
		if (message.kind === "pair") {
			if (this.clientId || message.sequence !== 1) {
				reply(409)
				return
			}
			this.clientId = message.clientId
			this.tabId = message.tabId
			this.documentId = message.documentId
			this.url = sanitizeBrowserUrl(message.url)
			this.deadline = Date.now() + 30 * 60_000
		} else if (!this.clientId || message.clientId !== this.clientId || message.sequence !== this.sequence + 1) {
			reply(409)
			return
		}
		this.sequence = message.sequence
		this.lastSeen = Date.now()
		if (req.url === "/revoke") {
			reply(200)
			this.stop()
			return
		}
		if ("documentId" in message && message.documentId !== this.documentId) {
			this.documentId = message.documentId
			this.generation++
			if (this.pending) {
				const pending = this.pending
				this.pending = undefined
				clearTimeout(pending.timer)
				pending.resolve(
					this.failure(
						pending.command.action,
						"stale_reference",
						"The attached document changed. Take a fresh snapshot.",
					),
				)
			}
		}
		if ("url" in message) this.url = sanitizeBrowserUrl(message.url)
		if (message.kind === "result") {
			const pending = this.pending
			if (
				!pending ||
				!pending.sent ||
				pending.id !== message.requestId ||
				pending.documentId !== message.documentId
			) {
				reply(409)
				return
			}
			this.pending = undefined
			clearTimeout(pending.timer)
			pending.resolve(
				message.ok
					? {
							ok: true,
							action: pending.command.action,
							state: this.getState(),
							warnings: ["Page metadata is untrusted and may contain secrets."],
							data: message.data,
						}
					: this.failure(
							pending.command.action,
							message.error ?? "operation_failed",
							"Chrome could not complete the command. No retry was attempted.",
						),
			)
		}
		if (req.url === "/poll" && this.pending && !this.pending.sent) {
			this.pending.sent = true
			reply(200, { requestId: this.pending.id, documentId: this.documentId, command: this.pending.command })
		} else reply(200, {})
	}
}
