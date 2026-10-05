import { context7QueryDocs, context7ResolveLibraryId } from "../context7"

describe.each([
	{
		name: "library search",
		request: context7ResolveLibraryId,
		endpoint: "/api/v2/libs/search",
		param: "libraryName",
		value: "next.js",
	},
	{
		name: "documentation",
		request: context7QueryDocs,
		endpoint: "/api/v2/context",
		param: "libraryId",
		value: "/vercel/next.js",
	},
])("Context7 $name authentication", ({ request, endpoint, param, value }) => {
	const fetchMock = vi.fn<typeof fetch>()

	beforeEach(() => {
		fetchMock.mockReset()
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ results: [] }), {
				headers: { "content-type": "application/json" },
			}),
		)
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => vi.unstubAllGlobals())

	it.each([undefined, "", " \t\n "])("omits Authorization for key %j", async (apiKey) => {
		await expect(request(apiKey, value, "routing examples")).resolves.toEqual({ results: [] })
		const [url, options] = fetchMock.mock.calls[0]
		expect(url).toBeInstanceOf(URL)
		expect((url as URL).origin).toBe("https://context7.com")
		expect((url as URL).pathname).toBe(endpoint)
		expect((url as URL).searchParams.get(param)).toBe(value)
		expect((url as URL).searchParams.get("query")).toBe("routing examples")
		expect(new Headers(options?.headers).has("Authorization")).toBe(false)
		if (request === context7QueryDocs) {
			expect((url as URL).searchParams.get("type")).toBe("json")
			expect(new Headers(options?.headers).get("Accept")).toBe("application/json")
		}
	})

	it("trims a configured key and sends bearer authentication", async () => {
		await request(" \tctx7-test-key\n", value, "routing examples")
		expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer ctx7-test-key")
	})

	it("preserves API errors for anonymous requests", async () => {
		fetchMock.mockResolvedValue(new Response("Rate limit exceeded", { status: 429 }))
		await expect(request(undefined, value, "routing examples")).rejects.toThrow(
			"Context7 API error (429): Rate limit exceeded",
		)
	})
})
