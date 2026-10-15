import axios from "axios"
import { tryChromeHostUrl } from "../browserDiscovery"

vi.mock("axios", () => ({ default: { get: vi.fn() } }))

describe("Chrome debugging endpoint probe", () => {
	beforeEach(() => vi.resetAllMocks())
	it("accepts a loopback SSH endpoint and normalizes a trailing slash", async () => {
		vi.mocked(axios.get).mockResolvedValue({
			data: {
				Browser: "Chrome/140",
				webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/session",
			},
		})
		expect(await tryChromeHostUrl("http://127.0.0.1:9222/")).toBe(true)
		expect(axios.get).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", {
			timeout: 1000,
			maxRedirects: 0,
			maxContentLength: 65536,
		})
	})
	it.each([
		"<html>Not Chrome</html>",
		{},
		{ Browser: "Chrome/140" },
		{ Browser: "Chrome/140", webSocketDebuggerUrl: "http://127.0.0.1:9222/devtools/browser/session" },
		{ Browser: "Chrome/140", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/session" },
	])("rejects a non-browser discovery response %j", async (data) => {
		vi.mocked(axios.get).mockResolvedValue({ data })
		expect(await tryChromeHostUrl("http://127.0.0.1:9222")).toBe(false)
	})
	it.each([
		"file:///tmp/browser",
		"http://user:secret@localhost:9222",
		"http://localhost:9222?token=secret",
		"not-a-url",
	])("rejects invalid or credential-bearing configuration without a request", async (url) => {
		expect(await tryChromeHostUrl(url)).toBe(false)
		expect(axios.get).not.toHaveBeenCalled()
	})
	it("returns false on refusal or timeout", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("ECONNREFUSED"))
		expect(await tryChromeHostUrl("http://127.0.0.1:9222")).toBe(false)
	})
})
