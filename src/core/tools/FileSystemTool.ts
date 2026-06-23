import path from "path"
import { promises as fs } from "fs"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { extractTextFromFile } from "../../integrations/misc/extract-text"
import { listFiles } from "../../services/glob/list-files"
import { regexSearchFiles } from "../../services/ripgrep"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

type Params = {
	action: "read_text_file" | "list_directory" | "search_files"
	path: string
	regex?: string
	file_pattern?: string | null
	recursive?: boolean
}

export class FileSystemTool extends BaseTool<"file_system"> {
	readonly name = "file_system" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action, path: relPath, regex, file_pattern, recursive } = params
		const { askApproval, pushToolResult } = callbacks

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "path"))
			return
		}

		if (action === "search_files" && !regex) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "regex"))
			return
		}

		const absolutePath = path.resolve(task.cwd, relPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
		const approval = JSON.stringify({
			tool: "fileSystem",
			action,
			path: getReadablePath(task.cwd, relPath),
			query: regex,
			content: "",
			isOutsideWorkspace,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0

		if (action === "read_text_file") {
			if (!task.rooIgnoreController?.validateAccess(relPath)) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}
			pushToolResult(await extractTextFromFile(absolutePath))
			return
		}

		if (action === "list_directory") {
			const [files, didHitLimit] = await listFiles(absolutePath, recursive || false, 200)
			const { showRooIgnoredFiles = false } = (await task.providerRef.deref()?.getState()) ?? {}
			const result = formatResponse.formatFilesList(
				absolutePath,
				files,
				didHitLimit,
				task.rooIgnoreController,
				showRooIgnoredFiles,
				task.rooProtectedController,
			)
			pushToolResult(result)
			return
		}

		if (action === "search_files") {
			const result = await regexSearchFiles(task.cwd, absolutePath, regex!, file_pattern || undefined, task.rooIgnoreController)
			pushToolResult(result)
			return
		}

		await fs.access(absolutePath)
	}

	override async handlePartial(task: Task, block: ToolUse<"file_system">): Promise<void> {
		const relPath = block.params.path ?? ""
		const absolutePath = relPath ? path.resolve(task.cwd, relPath) : task.cwd
		const partialMessage = JSON.stringify({
			tool: "fileSystem",
			action: block.params.action ?? "",
			path: getReadablePath(task.cwd, relPath),
			query: block.params.regex ?? "",
			content: "",
			isOutsideWorkspace: isPathOutsideWorkspace(absolutePath),
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const fileSystemTool = new FileSystemTool()
