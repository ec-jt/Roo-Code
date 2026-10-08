import path from "node:path"
import type { Task } from "../../core/task/Task"
import { inspectEnvironments } from "./index"
import { getManagedEnvironmentPolicy } from "./settings"

/** Advisory only: never execute Python, repair environments, or roll back an install. */
export async function getCheckpointEnvironmentWarning(task: Task): Promise<string | undefined> {
	const state = await task.providerRef.deref()?.getState()
	if (!state?.managedEnvironmentsEnabled) return
	const policy = getManagedEnvironmentPolicy(state)
	const accessible = (filename: string) =>
		task.rooIgnoreController?.validateAccess(filename) === true &&
		!task.rooProtectedController?.isWriteProtected(filename)
	if (![policy.root, policy.pythonPath].every(accessible))
		return "Managed environment compatibility was not checked: access is restricted. Environments were not changed."
	const inventory = await inspectEnvironments({ workspaceDir: task.cwd, policy })
	let mismatched = 0
	let skipped = 0
	for (const manifestPath of inventory.manifestPaths) {
		const relative = path.relative(task.cwd, manifestPath)
		if (
			!relative ||
			relative.startsWith(`..${path.sep}`) ||
			relative === ".." ||
			path.isAbsolute(relative) ||
			!accessible(manifestPath)
		) {
			skipped++
			continue
		}
		const status = await inspectEnvironments({ workspaceDir: task.cwd, manifestPath, policy })
		if (status.manifestMismatch || !status.selected) mismatched++
	}
	if (mismatched || skipped || inventory.invalidCount) {
		return `Checkpoint restored workspace files only. Managed environment definitions: ${mismatched} unmatched, ${skipped} access-restricted; ${inventory.invalidCount} invalid environment records. Inspect managed_environment status before running experiments. No environment, driver, or process was changed.`
	}
	return undefined
}
