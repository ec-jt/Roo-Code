import { z } from "zod"

const id = z.string().min(1).max(100)
const timeoutMs = z.number().int().min(100).max(15_000).optional()
const ref = { sessionId: id, tabId: id, ref: id, timeoutMs }
const selected = { sessionId: id, tabId: id, timeoutMs }

/** Strict on purpose: model-supplied approval flags and raw CDP methods are not accepted. */
export const browserControlCommandSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("status") }).strict(),
	z.object({ action: z.literal("tabs"), timeoutMs }).strict(),
	z.object({ action: z.literal("select_tab"), sessionId: id, tabId: id, timeoutMs }).strict(),
	z
		.object({
			action: z.literal("navigate"),
			url: z
				.string()
				.max(8192)
				.url()
				.refine((value) => /^https?:\/\//i.test(value)),
			timeoutMs,
		})
		.strict(),
	z
		.object({ action: z.literal("snapshot"), ...selected, limit: z.number().int().min(1).max(100).optional() })
		.strict(),
	z.object({ action: z.literal("click_ref"), ...ref }).strict(),
	z.object({ action: z.literal("fill_ref"), ...ref, text: z.string().max(10_000) }).strict(),
	z
		.object({ action: z.literal("select_ref"), ...ref, values: z.array(z.string().max(1000)).min(1).max(20) })
		.strict(),
	z.object({ action: z.literal("wait"), ...selected, durationMs: z.number().int().min(0).max(5000) }).strict(),
	z.object({ action: z.literal("console"), ...selected, clear: z.boolean().optional() }).strict(),
	z.object({ action: z.literal("network"), ...selected, clear: z.boolean().optional() }).strict(),
	z.object({ action: z.literal("inspect"), ...ref }).strict(),
	z
		.object({
			action: z.literal("styles"),
			...ref,
			properties: z
				.array(z.string().regex(/^[a-z-]{1,80}$/))
				.min(1)
				.max(30),
		})
		.strict(),
	z.object({ action: z.literal("performance"), ...selected }).strict(),
	z.object({ action: z.literal("evaluate"), ...selected, expression: z.string().min(1).max(10_000) }).strict(),
	z.object({ action: z.literal("response_body"), ...selected, requestId: id }).strict(),
	z.object({ action: z.literal("debugger"), ...selected }).strict(),
])

export type BrowserControlCommand = z.infer<typeof browserControlCommandSchema>
export type BrowserControlAction = BrowserControlCommand["action"]
export type BrowserControlErrorCategory =
	| "invalid_command"
	| "unsupported"
	| "not_connected"
	| "stale_reference"
	| "unauthorized_page"
	| "timeout"
	| "certificate"
	| "disconnected"
	| "operation_failed"

export interface BrowserControlState {
	sessionId: string
	connected: boolean
	tabId?: string
	generation: number
	transport: "cdp" | "chrome-extension"
	ownership: "roo-owned" | "attached" | "none"
	extensionHost: { platform: string; hostname: string; remoteName?: string }
	certificatePolicy: "verify" | "isolated-session-exception"
	capabilities: Record<BrowserControlAction | "certificate_exception", boolean>
}

export interface BrowserControlTab {
	id: string
	url: string
	selected: boolean
	owned: boolean
}
export interface BrowserControlElement {
	ref: string
	tag: string
	role: string
	name: string
	type: string
}
export interface BrowserControlConsoleEntry {
	time: number
	level: string
	text: string
}
export interface BrowserControlNetworkEntry {
	requestId: string
	url: string
	method: string
	status?: number
	failed?: boolean
}

export interface BrowserControlResult {
	ok: boolean
	action: BrowserControlAction | "invalid"
	state: BrowserControlState
	warnings: string[]
	data?: {
		tabs?: BrowserControlTab[]
		elements?: BrowserControlElement[]
		console?: BrowserControlConsoleEntry[]
		network?: BrowserControlNetworkEntry[]
		url?: string
		truncated?: boolean
		inspection?: { tag: string; role: string; name: string; type: string; connected: boolean }
		styles?: Record<string, string>
		metrics?: Record<string, number>
	}
	error?: { category: BrowserControlErrorCategory; message: string; guidance?: string; outcomeUnknown?: boolean }
}
