import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { getTaskDirectoryPath } from "../../utils/storage"
import { fileExistsAtPath } from "../../utils/fs"
import { safeWriteJson } from "../../utils/safeWriteJson"

export interface ErrorDiagnosticsValues {
	timestamp?: string
	version?: string
	provider?: string
	model?: string
	details?: string
}

export interface GenerateDiagnosticsParams {
	taskId: string
	globalStoragePath: string
	values?: ErrorDiagnosticsValues
	log: (message: string) => void
}

export interface GenerateDiagnosticsResult {
	success: boolean
	filePath?: string
	error?: string
}

/**
 * Generates an error diagnostics file containing error metadata and API conversation history.
 * The file is created in the system temp directory and opened in VS Code for the user to review
 * before sharing with support.
 */
export async function generateErrorDiagnostics(params: GenerateDiagnosticsParams): Promise<GenerateDiagnosticsResult> {
	const { taskId, globalStoragePath, values, log } = params

	try {
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, taskId)

		// Load API conversation history from the same file used by openDebugApiHistory
		const apiHistoryPath = path.join(taskDirPath, "api_conversation_history.json")
		let history: unknown = []

		if (await fileExistsAtPath(apiHistoryPath)) {
			const content = await fs.readFile(apiHistoryPath, "utf8")
			try {
				history = JSON.parse(content)
			} catch {
				// If parsing fails, fall back to empty history but still generate diagnostics file
				vscode.window.showErrorMessage("Failed to parse api_conversation_history.json")
			}
		}

		const diagnostics = {
			sharingNotice:
				"This report contains conversation history and may contain private data. Review and redact it before attaching it to a GitHub issue. Nothing is uploaded automatically.",
			error: {
				timestamp: values?.timestamp ?? new Date().toISOString(),
				version: values?.version ?? "",
				provider: values?.provider ?? "",
				model: values?.model ?? "",
				details: values?.details ?? "",
			},
			history,
		}

		// Create a temporary diagnostics file
		const tmpDir = os.tmpdir()
		const timestamp = Date.now()
		const tempFileName = `roo-diagnostics-${taskId.slice(0, 8)}-${timestamp}.json`
		const tempFilePath = path.join(tmpDir, tempFileName)

		await safeWriteJson(tempFilePath, diagnostics, { prettyPrint: true })

		// Open the diagnostics file in VS Code
		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })

		return { success: true, filePath: tempFilePath }
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		log(`Error generating diagnostics: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate diagnostics: ${errorMessage}`)
		return { success: false, error: errorMessage }
	}
}
