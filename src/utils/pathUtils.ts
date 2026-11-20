import * as vscode from "vscode"
import * as path from "path"

/**
 * Checks if a file path is outside all workspace folders
 * @param filePath The file path to check
 * @param extraRoots Additional folders that count as inside the workspace, for example the
 *   git worktree of an isolated subtask. Without extra roots the behaviour is unchanged.
 * @returns true if the path is outside all workspace folders and extra roots, false otherwise
 */
export function isPathOutsideWorkspace(filePath: string, extraRoots?: readonly string[]): boolean {
	// Normalize and resolve the path to handle .. and . components correctly
	const absolutePath = path.resolve(filePath)

	if (extraRoots && extraRoots.length > 0) {
		const insideExtraRoot = extraRoots.some((root) => {
			if (!root) return false
			const rootPath = path.resolve(root)
			return absolutePath === rootPath || absolutePath.startsWith(rootPath + path.sep)
		})
		if (insideExtraRoot) {
			return false
		}
	}

	// If there are no workspace folders, consider everything outside workspace for safety
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return true
	}

	// Check if the path is within any workspace folder
	return !vscode.workspace.workspaceFolders.some((folder) => {
		const folderPath = folder.uri.fsPath
		// Path is inside a workspace if it equals the workspace path or is a subfolder
		return absolutePath === folderPath || absolutePath.startsWith(folderPath + path.sep)
	})
}
