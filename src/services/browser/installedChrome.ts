import * as fs from "fs/promises"
import { constants } from "fs"
import * as os from "os"
import * as path from "path"

/** Search only standard local installations. Never download or probe debugging endpoints. */
export async function findInstalledChrome(): Promise<string> {
	let candidates: string[]
	if (process.platform === "darwin") {
		const binary = "Google Chrome.app/Contents/MacOS/Google Chrome"
		candidates = [path.join("/Applications", binary), path.join(os.homedir(), "Applications", binary)]
	} else if (process.platform === "win32") {
		candidates = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
			.filter((root): root is string => !!root && path.win32.isAbsolute(root))
			.map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe"))
	} else {
		throw new Error(
			"Installed Google Chrome is supported only on macOS and Windows. Select managed Chromium in Browser settings, or configure a trusted remote browser. No browser was downloaded or launched.",
		)
	}
	for (const candidate of candidates) {
		try {
			if (!(await fs.stat(candidate)).isFile()) continue
			await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
			return candidate
		} catch {
			// Missing or inaccessible installation; check the next standard location.
		}
	}
	throw new Error(
		"Installed Google Chrome was not found in a standard application location. Install Google Chrome on this extension host, or select managed Chromium in Browser settings. No fallback or download was attempted.",
	)
}
