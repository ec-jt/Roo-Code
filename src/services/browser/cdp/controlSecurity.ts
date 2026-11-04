import type { BrowserControlResult } from "../../../../packages/types/src/browser-control"

/** Metadata only. Raw DOM and console text have a separate sensitive-output warning. */
export function sanitizeBrowserUrl(value: string): string {
	try {
		const url = new URL(value)
		if (!["http:", "https:"].includes(url.protocol)) return "[non-web URL]"
		url.username = ""
		url.password = ""
		url.search = ""
		url.hash = ""
		return url.toString().slice(0, 2000)
	} catch {
		return "[invalid URL]"
	}
}

export class ControlError extends Error {
	constructor(
		readonly category: NonNullable<BrowserControlResult["error"]>["category"],
		message: string,
	) {
		super(message)
	}
}

export function controlError(error: unknown): NonNullable<BrowserControlResult["error"]> {
	if (error instanceof ControlError) return { category: error.category, message: error.message }
	// Never return raw protocol errors: they can include URLs, expressions, or input values.
	const text = error instanceof Error ? error.message : ""
	if (/ERR_CERT_|ERR_SSL_|certificate/i.test(text))
		return {
			category: "certificate",
			message: "TLS certificate verification failed. Verification remains enabled.",
			guidance:
				"Check the certificate chain, hostname, expiry, system clock, and browser trust store. The extension host identifies where a local browser runs; an attached browser may run elsewhere. If necessary, the user can review a new isolated local certificate session in Browser controls. Attached browsers cannot receive an exception.",
		}
	if (/disconnect|Target closed|Session closed|Connection closed/i.test(text))
		return {
			category: "disconnected",
			message: "The browser or selected tab disconnected. The action was not retried.",
			outcomeUnknown: true,
		}
	if (/timeout|timed out/i.test(text))
		return {
			category: "timeout",
			message: "The browser operation timed out. The action was not retried.",
			outcomeUnknown: true,
		}
	return {
		category: "operation_failed",
		message: "Browser operation failed. Sensitive protocol details were omitted; the action was not retried.",
		outcomeUnknown: true,
	}
}
