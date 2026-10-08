import path from "node:path"
import type { GlobalSettings } from "@roo-code/types"
import type { ManagedEnvironmentPolicy } from "./index"

export const DEFAULT_MANIFEST_PATH = "roo-environment.json"

export function getManagedEnvironmentPolicy(state?: Partial<GlobalSettings>): ManagedEnvironmentPolicy {
	if (state?.managedEnvironmentsEnabled !== true) throw new Error("Managed environments are disabled in settings")
	const root = state.managedEnvironmentsRoot?.trim()
	const pythonPath = state.managedEnvironmentsPythonPath?.trim()
	if (!root || !pythonPath || !path.isAbsolute(root) || !path.isAbsolute(pythonPath)) {
		throw new Error("Configure an absolute managed root and Python executable in Experimental settings")
	}
	const bounded = (value: number | undefined, fallback: number, max: number) => {
		const result = value ?? fallback
		if (!Number.isSafeInteger(result) || result < 1 || result > max)
			throw new Error("Invalid managed environment limit")
		return result
	}
	return {
		root,
		pythonPath,
		maxDownloadBytes: bounded(state.managedEnvironmentsMaxDownloadMb, 512, 2048) * 1024 ** 2,
		maxDiskBytes: bounded(state.managedEnvironmentsMaxDiskMb, 2048, 20480) * 1024 ** 2,
		timeoutMs: bounded(state.managedEnvironmentsTimeoutSeconds, 600, 3600) * 1000,
	}
}
