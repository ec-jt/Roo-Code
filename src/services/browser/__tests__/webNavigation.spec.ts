import type { Page } from "puppeteer-core"
import { restrictWebNavigation, validatePageUrl } from "../webNavigation"

describe("web navigation boundary", () => {
	it.each(["file:///private/test", "data:text/html,blocked", "javascript:void(0)", "ftp://example.com"])(
		"blocks redirected or clicked document requests to %s",
		async (url) => {
			const page = { on: vi.fn(), off: vi.fn(), setRequestInterception: vi.fn().mockResolvedValue(undefined) }
			const cleanup = await restrictWebNavigation(page as unknown as Page)
			const request = {
				isInterceptResolutionHandled: () => false,
				isNavigationRequest: () => true,
				url: () => url,
				continue: vi.fn().mockResolvedValue(undefined),
				abort: vi.fn().mockResolvedValue(undefined),
			}
			page.on.mock.calls[0][1](request)
			expect(request.abort).toHaveBeenCalledWith("blockedbyclient")
			expect(request.continue).not.toHaveBeenCalled()
			await cleanup()
			expect(page.setRequestInterception).toHaveBeenLastCalledWith(false)
			expect(page.off).toHaveBeenCalledWith("request", page.on.mock.calls[0][1])
		},
	)
	it.each(["about:blank", "https://example.com", "http://localhost:3000"])("allows %s", async (url) => {
		const page = { on: vi.fn(), off: vi.fn(), url: () => url, setRequestInterception: vi.fn() }
		await restrictWebNavigation(page as unknown as Page)
		const request = {
			isInterceptResolutionHandled: () => false,
			isNavigationRequest: () => true,
			url: () => url,
			continue: vi.fn().mockResolvedValue(undefined),
		}
		page.on.mock.calls[0][1](request)
		expect(request.continue).toHaveBeenCalledOnce()
		expect(() => validatePageUrl(page as unknown as Page)).not.toThrow()
	})
	it("rejects a disallowed committed URL even when Chromium did not emit an intercepted request", () => {
		expect(() => validatePageUrl({ url: () => "file:///private/test" } as Page)).toThrow(/HTTP/)
	})
})
