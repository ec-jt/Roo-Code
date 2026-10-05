import type { HTTPRequest, Page } from "puppeteer-core"
import { validateWebUrl } from "./validateWebUrl"

/** Blank pages are browser initialization state, not an allowed tool destination. */
export function validatePageUrl(page: Page): void {
	const url = page.url()
	if (url !== "about:blank") validateWebUrl(url)
}

/** Guard redirects and link/form navigations as well as explicit goto calls. */
export async function restrictWebNavigation(page: Page): Promise<() => Promise<void>> {
	const onRequest = (request: HTTPRequest) => {
		if (request.isInterceptResolutionHandled()) return
		let allowed = true
		if (request.isNavigationRequest() && request.url() !== "about:blank") {
			try {
				validateWebUrl(request.url())
			} catch {
				allowed = false
			}
		}
		void (allowed ? request.continue() : request.abort("blockedbyclient")).catch(() => {})
	}
	page.on("request", onRequest)
	try {
		await page.setRequestInterception(true)
	} catch (error) {
		page.off("request", onRequest)
		throw error
	}
	return async () => {
		// Restore interception before disconnecting from a user-owned remote browser.
		try {
			await page.setRequestInterception(false)
		} finally {
			page.off("request", onRequest)
		}
	}
}
