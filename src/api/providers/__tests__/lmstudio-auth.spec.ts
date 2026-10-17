import OpenAI from "openai"
import { LmStudioHandler } from "../lm-studio"
import { SECRET_STATE_KEYS, GLOBAL_STATE_KEYS } from "@roo-code/types"

vi.mock("../utils/sdk-timeout", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/sdk-timeout")>()
	return {
		...actual,
		configureApiRequestTimeout: (client: Parameters<typeof actual.configureApiRequestTimeout>[0]) =>
			actual.configureApiRequestTimeout(client, (input, init) => globalThis.fetch(input, init)),
	}
})

describe("LM Studio optional authentication transport", () => {
	afterEach(() => vi.restoreAllMocks())
	it.each([undefined, "", "  ", "test-token"])("sends only configured credentials (%s)", async (token) => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
					headers: { "content-type": "application/json" },
				}),
			)
		const handler = new LmStudioHandler({
			lmStudioBaseUrl: "http://lmstudio.test/v1/",
			lmStudioApiKey: token,
			lmStudioModelId: "custom-id",
		})
		expect(await handler.completePrompt("synthetic test")).toBe("OK")
		const request = fetchMock.mock.calls[0]
		const headers = new Headers(request[1]?.headers)
		expect(headers.get("authorization")).toBe(token?.trim() ? "Bearer test-token" : null)
		expect(String(request[0])).toBe("http://lmstudio.test/v1/chat/completions")
	})
	it("stores the optional token as a secret rather than ordinary global state", () => {
		expect(SECRET_STATE_KEYS).toContain("lmStudioApiKey")
		expect(GLOBAL_STATE_KEYS).not.toContain("lmStudioApiKey")
	})
	it("reports authentication status without exposing server response content", async () => {
		const handler = new LmStudioHandler({ lmStudioModelId: "model", lmStudioApiKey: "secret-test" })
		const create = vi
			.spyOn(OpenAI.Chat.Completions.prototype, "create")
			.mockRejectedValue(Object.assign(new Error("secret-test response"), { status: 401 }))
		await expect(handler.completePrompt("synthetic test")).rejects.toMatchObject({
			status: 401,
			message: "LM Studio authentication failed (HTTP 401). Check the API token and server permissions.",
		})
		expect(create).toHaveBeenCalledTimes(1)
	})
})
