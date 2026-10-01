// cd src && npx vitest run api/providers/fetchers/__tests__/openai-codex.spec.ts

import { fetchOpenAiCodexModels, parseOpenAiCodexModels } from "../openai-codex"

const makeResponse = (body: unknown, init: { ok?: boolean; status?: number; jsonThrows?: boolean } = {}) =>
	({
		ok: init.ok ?? true,
		status: init.status ?? 200,
		json: async () => {
			if (init.jsonThrows) {
				throw new SyntaxError("Unexpected token < in JSON")
			}
			return body
		},
	}) as unknown as Response

describe("parseOpenAiCodexModels", () => {
	it("parses the documented payload and sorts by priority then slug", () => {
		const payload = {
			models: [
				{ slug: "gpt-5.5", priority: 0, supported_in_api: true },
				{ slug: "gpt-5.3-codex-spark", priority: 7, supported_in_api: false },
			],
		}

		expect(parseOpenAiCodexModels(payload)).toEqual(["gpt-5.5", "gpt-5.3-codex-spark"])
	})

	it("sorts by priority ascending, breaking ties by slug", () => {
		const payload = {
			models: [
				{ slug: "b", priority: 2 },
				{ slug: "c", priority: 1 },
				{ slug: "a", priority: 1 },
				{ slug: "no-priority" },
			],
		}

		expect(parseOpenAiCodexModels(payload)).toEqual(["a", "c", "b", "no-priority"])
	})

	it("skips entries without a non-empty string slug", () => {
		const payload = {
			models: [{ priority: 0 }, { slug: "" }, { slug: "   " }, { slug: 42 }, { slug: "keep", priority: 1 }],
		}

		expect(parseOpenAiCodexModels(payload)).toEqual(["keep"])
	})

	it("skips entries whose visibility is hide or hidden", () => {
		const payload = {
			models: [
				{ slug: "visible", priority: 1 },
				{ slug: "hidden-a", priority: 0, visibility: "hide" },
				{ slug: "hidden-b", priority: 0, visibility: "hidden" },
				{ slug: "hidden-c", priority: 0, visibility: "HIDDEN" },
				{ slug: "shown", priority: 2, visibility: "show" },
			],
		}

		expect(parseOpenAiCodexModels(payload)).toEqual(["visible", "shown"])
	})

	it("dedupes while preserving the first ranked occurrence", () => {
		const payload = {
			models: [
				{ slug: "dup", priority: 3 },
				{ slug: "dup", priority: 1 },
				{ slug: "other", priority: 2 },
			],
		}

		expect(parseOpenAiCodexModels(payload)).toEqual(["dup", "other"])
	})

	it("keeps supported_in_api: false entries (Codex-only slugs)", () => {
		const payload = {
			models: [
				{ slug: "gpt-5.3-codex-spark", priority: 1, supported_in_api: false },
				{ slug: "gpt-5.5", priority: 0, supported_in_api: true },
			],
		}

		expect(parseOpenAiCodexModels(payload)).toContain("gpt-5.3-codex-spark")
	})

	it("returns [] for malformed payloads", () => {
		expect(parseOpenAiCodexModels(null)).toEqual([])
		expect(parseOpenAiCodexModels("nope")).toEqual([])
		expect(parseOpenAiCodexModels({ models: "nope" })).toEqual([])
		expect(parseOpenAiCodexModels({})).toEqual([])
	})
})

describe("fetchOpenAiCodexModels", () => {
	const originalFetch = globalThis.fetch

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	it("sends Authorization, ChatGPT-Account-Id, and OpenAI-Beta headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse({ models: [] }))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok_123",
			accountId: "acct_456",
		})

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [url, init] = fetchMock.mock.calls[0]
		expect(url).toBe("https://chatgpt.com/backend-api/codex/models")
		expect(init.method).toBe("GET")
		expect(init.headers.Authorization).toBe("Bearer tok_123")
		// The account id header is what prevents the silent empty-200 response.
		expect(init.headers["ChatGPT-Account-Id"]).toBe("acct_456")
		expect(init.headers["OpenAI-Beta"]).toBe("responses=experimental")
	})

	it("skips the request and returns [] when no account id is provided", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse({ models: [] }))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex/",
			accessToken: "tok_123",
		})

		// Without the account id the endpoint replies 200 with an empty list, so calling it
		// would only produce a misleading "no models" result.
		expect(result).toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("returns [] on a non-200 response", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse({ models: [] }, { ok: false, status: 500 }))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok",
			accountId: "acct",
		})

		expect(result).toEqual([])
	})

	it("returns [] on malformed JSON", async () => {
		const fetchMock = vi.fn().mockResolvedValue(makeResponse(undefined, { jsonThrows: true }))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok",
			accountId: "acct",
		})

		expect(result).toEqual([])
	})

	it("returns [] on a network error", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok",
			accountId: "acct",
		})

		expect(result).toEqual([])
	})

	it("returns [] without calling fetch when the access token is missing", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "",
			accountId: "acct",
		})

		expect(result).toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("returns the ordered discovered ids on success", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			makeResponse({
				models: [
					{ slug: "gpt-6-luna", priority: 2 },
					{ slug: "gpt-6-sol", priority: 1 },
					{ slug: "secret", priority: 0, visibility: "hide" },
				],
			}),
		)
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok",
			accountId: "acct",
		})

		expect(result).toEqual(["gpt-6-sol", "gpt-6-luna"])
	})

	it("returns [] immediately when the provided signal is already aborted", async () => {
		const fetchMock = vi.fn()
		globalThis.fetch = fetchMock as unknown as typeof fetch

		const controller = new AbortController()
		controller.abort()

		const result = await fetchOpenAiCodexModels({
			baseUrl: "https://chatgpt.com/backend-api/codex",
			accessToken: "tok",
			accountId: "acct",
			signal: controller.signal,
		})

		expect(result).toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
