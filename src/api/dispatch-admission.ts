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

export class ModelDispatchControl extends Error {
	constructor(readonly code: ModelDispatchControlCode) {
		super(`Model dispatch stopped: ${code}`)
		this.name = "ModelDispatchControl"
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
		throw error instanceof ModelDispatchControl ? error : new ModelDispatchControl("dispatch-failed")
	}
}
