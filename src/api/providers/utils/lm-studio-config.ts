/** Normalize the server root for both discovery and OpenAI-compatible inference. */
export function normalizeLMStudioBaseUrl(baseUrl?: string): string {
	try {
		const value = baseUrl?.trim() || "http://localhost:1234"
		const url = new URL(value)
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			value.includes("?") ||
			value.includes("#")
		) {
			throw new Error()
		}
		url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/`
		return url.toString()
	} catch {
		// Never include user input: it may contain credentials or a token in a query.
		throw new Error(
			"Invalid LM Studio base URL. Use an HTTP(S) server URL without credentials, query, or fragment.",
		)
	}
}

/** Only allow known status/code values into errors exposed to the UI or logs. */
export function safeLMStudioError(error: unknown): Error {
	const details = error as { response?: { status?: unknown }; code?: unknown } | undefined
	const status = details?.response?.status
	if (status === 401 || status === 403) {
		return new Error(
			`LM Studio authentication failed (HTTP ${status}). Check the API token and server permissions.`,
		)
	}
	if (typeof status === "number" && Number.isInteger(status) && status >= 300 && status <= 599) {
		return new Error(`LM Studio model discovery failed (HTTP ${status}).`)
	}
	if (["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(String(details?.code))) {
		return new Error("LM Studio model discovery timed out.")
	}
	if (details?.code === "ECONNREFUSED") {
		return new Error("Could not connect to LM Studio. Check the server address and whether the server is running.")
	}
	return new Error("Could not discover LM Studio models. Check the server connection and API compatibility.")
}

/** Preserve HTTP status without logging server response bodies or request secrets. */
export function safeLMStudioInferenceError(error: unknown): Error {
	const status = (error as { status?: number } | undefined)?.status
	const message =
		status === 401 || status === 403
			? `LM Studio authentication failed (HTTP ${status}). Check the API token and server permissions.`
			: status === 400
				? "LM Studio rejected the request (HTTP 400). Check the model ID, tool support, and loaded context size in the server logs."
				: typeof status === "number" && status >= 300 && status <= 599
					? `LM Studio request failed (HTTP ${status}). Check the server logs.`
					: "LM Studio request failed. Check the server connection and developer logs."
	const result = new Error(message) as Error & { status?: number }
	if (typeof status === "number") result.status = status
	return result
}
