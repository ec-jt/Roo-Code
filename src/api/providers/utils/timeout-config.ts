import * as vscode from "vscode"
import { Package } from "../../../shared/package"

/**
 * Milliseconds until response headers arrive, per attempt. Zero disables the
 * client deadline. SDK clients must also use configureApiRequestTimeout:
 * passing zero directly to these SDKs schedules an immediate abort, while
 * undefined restores their ten-minute default.
 */
export function getApiRequestTimeout(): number {
	const seconds = vscode.workspace.getConfiguration(Package.name).get<number>("apiRequestTimeout", 0)
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
		return 0
	}

	// Keep integer SDK validation and timer arithmetic safe, even for manually
	// edited settings outside the contributed UI range. The transport chunks
	// long deadlines instead of passing an overflowing delay to Node's timers.
	return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.ceil(seconds * 1000)))
}
