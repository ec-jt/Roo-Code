import * as vscode from "vscode"
import { Package } from "../../../shared/package"

/**
 * Gets the API request timeout from VSCode configuration with validation.
 *
 * @returns The timeout in milliseconds. Returns undefined to disable timeout
 *          (letting the SDK use its default), or a positive number for explicit timeout.
 */
export function getApiRequestTimeout(): number | undefined {
	// Default to no client-side timeout (0) so long agentic tasks keep running even
	// when the webview tab is hidden or backgrounded. Users can set an explicit
	// positive value (seconds) to cap requests; the SDK default is never used as a
	// silent abort for unattended runs.
	const configTimeout = vscode.workspace.getConfiguration(Package.name).get<number>("apiRequestTimeout", 0)

	// Validate that it's actually a number and not NaN
	if (typeof configTimeout !== "number" || isNaN(configTimeout)) {
		return undefined // No timeout
	}

	// 0 or negative means "no timeout" - return undefined to let the request run
	// until the server closes it (OpenAI SDK interprets 0 as "abort immediately",
	// so we return undefined instead).
	if (configTimeout <= 0) {
		return undefined
	}

	return configTimeout * 1000 // Convert to milliseconds
}
