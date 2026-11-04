import { z } from "zod"
import type { BrowserControlState, BrowserControlTab } from "./browser-control.js"

const id = z.string().min(1).max(100)
const correlation = { requestId: id, taskId: id }
const session = { ...correlation, instanceId: id, sessionId: id }

/** Narrow native panel protocol. It deliberately cannot carry a browser command. */
export const browserSessionRequestSchema = z.discriminatedUnion("action", [
	z.object({ ...correlation, action: z.literal("refresh") }).strict(),
	z.object({ ...session, action: z.literal("tabs") }).strict(),
	z.object({ ...session, action: z.literal("select"), tabId: id }).strict(),
	z.object({ ...session, action: z.literal("disconnect") }).strict(),
	z.object({ ...session, action: z.literal("start_bridge") }).strict(),
	z.object({ ...session, action: z.literal("stop_bridge") }).strict(),
	z.object({ ...session, action: z.literal("start_certificate_session") }).strict(),
])
export type BrowserSessionRequest = z.infer<typeof browserSessionRequestSchema>
export interface BrowserSessionResponse {
	requestId: string
	taskId: string
	instanceId?: string
	/** Echo of the reviewed session, including for disconnect replies. */
	requestedSessionId?: string
	state?: BrowserControlState
	tabs?: BrowserControlTab[]
	cancelled?: boolean
	error?: string
}
