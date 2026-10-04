import { validateWebUrl } from "../validateWebUrl"
import { UrlContentFetcher } from "../UrlContentFetcher"
import type { ExtensionContext } from "vscode"

describe("web URL validation", () => {
	it.each(["https://example.com", "http://localhost:8080/path", "HTTPS://example.com"])("accepts %s", (url) =>
		expect(() => validateWebUrl(url)).not.toThrow(),
	)

	it.each(["file:///synthetic/blocked.txt", "data:text/plain,example", "javascript:void(0)", "relative/path"])(
		"rejects %s at the shared fetcher boundary",
		async (url) => {
			const fetcher = new UrlContentFetcher({} as ExtensionContext)
			await expect(fetcher.urlToMarkdown(url)).rejects.toThrow(/HTTP/)
		},
	)
})
