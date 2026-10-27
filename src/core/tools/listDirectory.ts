import path from "path"
import type { Task } from "../task/Task"
import type { RooIgnoreController } from "../ignore/RooIgnoreController"
import { formatResponse } from "../prompts/responses"
import { listFiles } from "../../services/glob/list-files"

/** Listing already checked policy in its isolated worker; formatting must not stat paths again. */
export async function listDirectory(
	task: Task,
	absolutePath: string,
	recursive: boolean,
	signal: AbortSignal,
): Promise<string> {
	const result = await listFiles(absolutePath, recursive, 200, {
		signal,
		policy: { cwd: task.cwd, content: task.rooIgnoreController?.rooIgnoreContent ?? "" },
	})
	signal.throwIfAborted()
	const { showRooIgnoredFiles = false } = (await task.providerRef.deref()?.getState()) ?? {}
	signal.throwIfAborted()
	// formatFilesList only uses validateAccess. Use the scan's cached decisions,
	// not RooIgnoreController.validateAccess, which calls realpathSync.
	const cachedPolicy = {
		validateAccess: (filename: string) => !result.ignoredPaths?.has(path.resolve(filename)),
	} as RooIgnoreController
	const formatted = formatResponse.formatFilesList(
		absolutePath,
		result[0],
		result[1],
		cachedPolicy,
		showRooIgnoredFiles,
		task.rooProtectedController,
	)
	return result.reason ? `${formatted}\n\n${result.reason}` : formatted
}
