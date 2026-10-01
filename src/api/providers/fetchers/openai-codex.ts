import { MODEL_FETCH_TIMEOUT_MS } from "./fetch-timeout"

/**
 * Model discovery for the OpenAI Codex (ChatGPT subscription) backend.
 *
 * WARNING: Driving the ChatGPT Codex backend with a subscription-backed OAuth token is
 * outside OpenAI's API terms of service. It can be rate-limited, changed, or blocked at any
 * time. This is not official API support; discovery is best-effort and always degrades to the
 * static curated list in `@roo-code/types`.
 *
 * Contract (verified against the `openai-api-server-via-codex` and `hermes-agent` reference
 * implementations):
 * - `GET {baseUrl}/models` with `Authorization: Bearer <access_token>`,
 *   `ChatGPT-Account-Id: <account id>`, and `OpenAI-Beta: responses=experimental`.
 * - Response shape: `{ "models": [ { "slug": string, "priority": number,
 *   "supported_in_api": boolean, "visibility": string } ] }`.
 *
 * Critical: without the `ChatGPT-Account-Id` header the endpoint returns HTTP 200 with
 * `{"models":[]}`, which is indistinguishable from "this account has no models". Callers must
 * always pass the account id and keep a curated fallback for the empty case.
 */

type RawCodexModelEntry = {
	slug?: unknown
	priority?: unknown
	supported_in_api?: unknown
	visibility?: unknown
}

/** Default rank for entries without a usable numeric priority (mirrors the reference impl). */
const DEFAULT_PRIORITY = 10_000

/**
 * Parse a Codex `/models` payload into an ordered list of model slugs.
 *
 * Rules (from `hermes-agent` `_ranked_slugs`):
 * - Skip entries without a non-empty string `slug`.
 * - Skip entries whose `visibility` is `hide` or `hidden`.
 * - Sort by `priority` ascending, then by slug; dedupe (first occurrence wins).
 * - Do NOT filter on `supported_in_api`: that flag describes the public OpenAI API, while the
 *   Codex backend still accepts slugs marked `false` there (for example `gpt-5.3-codex-spark`).
 */
export function parseOpenAiCodexModels(payload: unknown): string[] {
	const models =
		payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
			? ((payload as { models: unknown[] }).models as unknown[])
			: []

	const sortable: Array<{ rank: number; slug: string }> = []

	for (const entry of models) {
		if (!entry || typeof entry !== "object") {
			continue
		}

		const item = entry as RawCodexModelEntry

		const slug = item.slug
		if (typeof slug !== "string" || !slug.trim()) {
			continue
		}

		const visibility = item.visibility
		if (typeof visibility === "string" && ["hide", "hidden"].includes(visibility.trim().toLowerCase())) {
			continue
		}

		const rank =
			typeof item.priority === "number" && Number.isFinite(item.priority) ? item.priority : DEFAULT_PRIORITY

		sortable.push({ rank, slug: slug.trim() })
	}

	sortable.sort((a, b) => {
		if (a.rank !== b.rank) {
			return a.rank - b.rank
		}
		return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0
	})

	const seen = new Set<string>()
	const ordered: string[] = []
	for (const { slug } of sortable) {
		if (!seen.has(slug)) {
			seen.add(slug)
			ordered.push(slug)
		}
	}

	return ordered
}

/**
 * Resolve the ordered list of model slugs entitled to the signed-in ChatGPT account.
 *
 * Never throws: returns `[]` on any failure (missing token, non-200, network error, timeout, or
 * malformed JSON) so callers can fall back to the static curated list. Secrets are never logged.
 */
export async function fetchOpenAiCodexModels({
	baseUrl,
	accessToken,
	accountId,
	signal,
}: {
	baseUrl: string
	accessToken: string
	accountId?: string | null
	signal?: AbortSignal
}): Promise<string[]> {
	if (!accessToken || !accessToken.trim()) {
		return []
	}

	// The per-account catalog requires the account id. Without it the endpoint replies HTTP 200
	// with an empty list, which masquerades as "this account has no models". Skip the request.
	if (!accountId || !accountId.trim()) {
		return []
	}

	const url = `${baseUrl.replace(/\/+$/, "")}/models`

	const controller = new AbortController()
	const onExternalAbort = () => controller.abort()

	if (signal) {
		if (signal.aborted) {
			return []
		}
		signal.addEventListener("abort", onExternalAbort, { once: true })
	}

	const timeout = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS)

	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
			"OpenAI-Beta": "responses=experimental",
		}

		// Without the account id the endpoint replies HTTP 200 with an empty list.
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId
		}

		const response = await fetch(url, { method: "GET", headers, signal: controller.signal })
		if (!response.ok) {
			return []
		}

		const payload = (await response.json()) as unknown
		return parseOpenAiCodexModels(payload)
	} catch {
		// Intentionally silent: callers degrade to the static list rather than surfacing an error,
		// and we must never log tokens or the account id.
		return []
	} finally {
		clearTimeout(timeout)
		if (signal) {
			signal.removeEventListener("abort", onExternalAbort)
		}
	}
}
