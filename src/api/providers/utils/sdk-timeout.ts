import { getGlobalDispatcher, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici"

// Preserve the global dispatcher's proxy/TLS routing and connection policy.
// Undici documents zero as disabling header/body deadlines, unlike the SDK's
// setTimeout-based deadline. The existing connection-establishment timeout
// remains (normally 10 seconds); zero is unlimited waiting for inference and
// streaming, not an unlimited TCP/TLS/proxy handshake. No new pool is created.
const transportFetch: typeof globalThis.fetch = (input, init) =>
	undiciFetch(input as string, {
		...(init as UndiciRequestInit),
		dispatcher: getGlobalDispatcher().compose(
			(dispatch) => (options, handler) => dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler),
		),
	}) as unknown as Promise<Response>

const MAX_TIMER_DELAY = 2 ** 31 - 1

/**
 * Replace the public fetchWithTimeout seam shared by OpenAI 5 and Anthropic
 * 0.37 (including Azure/Vertex). Neither SDK supports an unlimited deadline.
 * Keep SDK serialization, retries, error classification and stream parsing,
 * but disable the transport's response-header and response-body deadlines.
 *
 * Zero means no client deadline. Positive values preserve the SDK's existing
 * per-attempt, time-to-headers scope, not a total stream-duration limit. An
 * explicit request timeout overrides the client timeout through the SDK.
 * Caller and SDK stream-controller cancellation remain active after headers.
 * The global dispatcher's connection-establishment deadline is retained, as
 * are server, proxy, OS and network failures. This is not a promise that
 * connections can remain pending forever.
 *
 * The optional fetch is a test seam; production always uses the dispatcher
 * above, not native fetch (which has its own finite default deadlines).
 */
export function configureApiRequestTimeout<T extends { timeout: number; fetchWithTimeout: unknown }>(
	client: T,
	fetch: typeof globalThis.fetch = transportFetch,
): T {
	return Object.assign(client, {
		async fetchWithTimeout(
			url: string,
			init: RequestInit | undefined,
			ms: number,
			controller: AbortController,
		): Promise<Response> {
			const { signal, method, ...options } = init ?? {}
			const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
			let timer: ReturnType<typeof setTimeout> | undefined

			// Node coerces delays larger than 2^31-1 to 1 ms. Chunk large explicit
			// deadlines instead. Never install a timer for the unlimited policy.
			const schedule = (remaining: number) => {
				const delay = Math.min(remaining, MAX_TIMER_DELAY)
				timer = setTimeout(() => {
					if (remaining > delay) schedule(remaining - delay)
					else controller.abort()
				}, delay)
			}
			if (Number.isFinite(ms) && ms > 0) schedule(ms)

			const isReadableBody =
				options.body instanceof ReadableStream ||
				(typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body)
			try {
				return await fetch(url, {
					...options,
					...(isReadableBody ? { duplex: "half" } : {}),
					method: method?.toUpperCase() ?? "GET",
					signal: combinedSignal,
				})
			} finally {
				clearTimeout(timer)
			}
		},
	})
}
