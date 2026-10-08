/** Terminal for automatic retry, but leaves manual context management available. */
export class ContextRecoveryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ContextRecoveryError"
	}
}

/** Only explicit input/context-limit rejections qualify, never output length or transport errors. */
export function checkContextWindowExceededError(error: unknown): boolean {
	try {
		if (!error || typeof error !== "object") return false
		const root = error as Record<string, any>
		const status = root.status ?? root.response?.status ?? root.error?.status
		if (status !== undefined && ![400, 413, 422].includes(Number(status))) return false
		if (
			["LengthFinishReasonError", "APIConnectionError", "APIConnectionTimeoutError", "AbortError"].includes(
				root.name,
			)
		)
			return false
		const nodes = [root, root.error, root.error?.error, root.response?.data?.error].filter(
			(node) => node && typeof node === "object",
		)
		if (
			nodes.some(
				(node) =>
					[
						"context_length_exceeded",
						"context_window_exceeded",
						"input_too_long",
						"prompt_too_long",
					].includes(node.code) || ["context_length_exceeded", "context_window_exceeded"].includes(node.type),
			)
		)
			return true
		const patterns = [
			/\bprompt (?:is )?too long\b/i,
			/\bcontext(?: length| window)? (?:is )?(?:too long|exceeded)\b/i,
			/\bexceeds? (?:the )?(?:maximum |model(?:'s)? )?context(?: length| window)?\b/i,
			/\bmaximum context (?:length|window)(?: of| is)? \d+\b/i,
			/\binput (?:token count|tokens?) (?:exceeds?|is greater than)\b/i,
			/\btoo many (?:input )?tokens\b/i,
		]
		return nodes.some((node) => {
			const code = node.type ?? node.code
			if (code && !["400", 400, "invalid_request_error", "INVALID_ARGUMENT", "error"].includes(code)) return false
			const rejected = status !== undefined || code === "invalid_request_error" || code === "INVALID_ARGUMENT"
			return (
				rejected && typeof node.message === "string" && patterns.some((pattern) => pattern.test(node.message))
			)
		})
	} catch {
		return false
	}
}
