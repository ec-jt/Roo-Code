import { randomUUID } from "node:crypto"

/** Runtime-only controls. None of these are ordinary provider retry errors. */
export type ModelDispatchControlCode =
	| "budget-wait"
	| "budget-denied"
	| "policy-denied"
	| "cancelled"
	| "stale"
	| "lease-expired"
	| "unsupported-provider"
	| "dispatch-failed"
	| "context-limit"

const MAX_CAUSE_DETAIL_CHARS = 300

/**
 * One-line provider failure summary such as "529 overloaded_error: Overloaded".
 * Uses only the status, the provider error type and the message. Never headers or request bodies.
 */
export function describeDispatchCause(cause: unknown, status?: number): string | undefined {
	if (cause === undefined || cause === null || cause instanceof ModelDispatchControl) return undefined
	const err = cause as any
	const body = err?.error?.error
	const type = typeof body?.type === "string" ? body.type : undefined
	let message =
		typeof body?.message === "string"
			? body.message
			: typeof err?.message === "string"
				? err.message
				: typeof cause === "string"
					? cause
					: undefined
	if (message && status !== undefined && message.startsWith(`${status} `))
		message = message.slice(`${status} `.length)
	message = message
		?.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim()
	if (message && message.length > MAX_CAUSE_DETAIL_CHARS) message = `${message.slice(0, MAX_CAUSE_DETAIL_CHARS)}...`
	const head = [status, type ? `${type}:` : undefined].filter((part) => part !== undefined).join(" ")
	const detail = [head, message].filter(Boolean).join(" ")
	return detail || undefined
}

export class ModelDispatchControl extends Error {
	/** HTTP status of the original provider error, when known. */
	readonly status?: number

	constructor(
		readonly code: ModelDispatchControlCode,
		options?: { cause?: unknown; status?: number },
	) {
		const cause = options?.cause
		const status =
			options?.status ?? (typeof (cause as any)?.status === "number" ? (cause as any).status : undefined)
		const detail = describeDispatchCause(cause, status)
		super(
			`Model dispatch stopped: ${code}${detail ? ` (${detail})` : ""}`,
			cause === undefined ? undefined : { cause },
		)
		this.name = "ModelDispatchControl"
		this.status = status
	}

	/** Serializers (debug logs, serialize-error) see only safe fields, never the raw cause's headers or body. */
	toJSON() {
		return { name: this.name, code: this.code, status: this.status, message: this.message }
	}
}

/** Deliberately excludes credentials, endpoint URLs, prompts, tool schemas, and response text. */
export interface ModelDispatchDescriptor {
	readonly operationId: string
	readonly dispatchId: string
	readonly purpose: "chat" | "condensation"
	readonly provider: "anthropic"
	readonly model: string
	readonly maxOutputTokens: number
}

export type DispatchSettlement = "not-dispatched" | "completed" | "unresolved"

export type DispatchAdmission =
	| { readonly outcome: "budget-wait" | "budget-denied" | "policy-denied" }
	| {
			readonly outcome: "granted"
			/** Optional runtime lease check, called immediately before dispatch. */
			readonly isValid?: () => boolean
			/** Exactly once, including late grants after cancellation. Not a billing assertion. */
			readonly settle: (outcome: DispatchSettlement) => void
	  }

export interface ModelDispatchRuntime {
	admit(descriptor: Readonly<ModelDispatchDescriptor>, signal: AbortSignal): Promise<DispatchAdmission>
}

export interface ModelDispatchContext {
	readonly runtime: ModelDispatchRuntime
	readonly operationId: string
	readonly purpose: ModelDispatchDescriptor["purpose"]
	readonly signal: AbortSignal
	readonly isCurrent: () => boolean
}

export function checkDispatch(context: ModelDispatchContext): void {
	if (context.signal.aborted) throw new ModelDispatchControl("cancelled")
	if (!context.isCurrent()) throw new ModelDispatchControl("stale")
}

/** Removes its listener on every exit, including a provider/runtime that ignores cancellation. */
export async function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {}
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				onAbort = () => reject(new ModelDispatchControl("cancelled"))
				if (signal.aborted) onAbort()
				else signal.addEventListener("abort", onAbort, { once: true })
			}),
		])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

/** Admission lives at the transport boundary, not at metadata construction. */
export async function admitDispatch(
	context: ModelDispatchContext,
	model: string,
	maxOutputTokens: number,
): Promise<{ settle: (outcome: DispatchSettlement) => void; checkLease: () => void }> {
	checkDispatch(context)
	const descriptor = Object.freeze({
		operationId: context.operationId,
		dispatchId: randomUUID(),
		purpose: context.purpose,
		provider: "anthropic" as const,
		model,
		maxOutputTokens,
	})
	let finished = false
	let grant: Extract<DispatchAdmission, { outcome: "granted" }> | undefined
	const settle = (outcome: DispatchSettlement) => {
		if (finished || !grant) return
		finished = true
		try {
			grant.settle(outcome)
		} catch {
			// Observer failure must never retry a possibly completed physical dispatch.
		}
	}
	let stopped = false
	try {
		const decision = await abortable(
			context.runtime.admit(descriptor, context.signal).then((result) => {
				if (result.outcome === "granted") {
					grant = result
					if (stopped) settle("not-dispatched")
				}
				return result
			}),
			context.signal,
		)
		if (decision.outcome !== "granted") throw new ModelDispatchControl(decision.outcome)
		checkDispatch(context)
		const checkLease = () => {
			if (decision.isValid && !decision.isValid()) throw new ModelDispatchControl("lease-expired")
		}
		checkLease()
		return { settle, checkLease }
	} catch (error) {
		stopped = true
		settle("not-dispatched")
		throw error instanceof ModelDispatchControl
			? error
			: new ModelDispatchControl("dispatch-failed", { cause: error })
	}
}
