import { browserControlCommandSchema } from "../../../packages/types/src/browser-control"
import { validateWebUrl } from "../../services/browser/validateWebUrl"

export const supportedBrowserControls = [
	"status",
	"tabs",
	"select_tab",
	"navigate",
	"snapshot",
	"click_ref",
	"fill_ref",
	"select_ref",
	"wait",
	"console",
	"network",
	"inspect",
	"styles",
	"performance",
] as const

export function parseBrowserControlCommand(raw: unknown) {
	let value = raw
	try {
		if (typeof raw === "string") value = JSON.parse(raw)
	} catch {
		throw new Error("Invalid browser control command JSON.")
	}
	const parsed = browserControlCommandSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid browser control command fields.")
	if (!(supportedBrowserControls as readonly string[]).includes(parsed.data.action))
		throw new Error("This browser control capability is not supported.")
	if (parsed.data.action === "navigate") validateWebUrl(parsed.data.url)
	return parsed.data
}
