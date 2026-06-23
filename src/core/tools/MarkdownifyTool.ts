import path from "path"

import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { extractTextFromFile } from "../../integrations/misc/extract-text"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

type Params = { path?: string; url?: string }

export class MarkdownifyTool extends BaseTool<"markdownify"> {
	readonly name = "markdownify" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { path: relPath, url } = params
		const { askApproval, pushToolResult } = callbacks

		if ((!relPath && !url) || (relPath && url)) {
			const error = "Provide exactly one of path or url."
			await task.say("error", error)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(error))
			return
		}

		const absolutePath = relPath ? path.resolve(task.cwd, relPath) : undefined
		const approval = JSON.stringify({
			tool: "markdownify",
			path: relPath ? getReadablePath(task.cwd, relPath) : undefined,
			url,
			content: url || relPath || "",
			isOutsideWorkspace: absolutePath ? isPathOutsideWorkspace(absolutePath) : false,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0

		if (relPath) {
			if (!task.rooIgnoreController?.validateAccess(relPath)) {
				await task.say("rooignore_error", relPath)
				pushToolResult(formatResponse.rooIgnoreError(relPath))
				return
			}
			pushToolResult(await extractTextFromFile(absolutePath!))
			return
		}

		await task.urlContentFetcher.launchBrowser()
		try {
			const markdown = await task.urlContentFetcher.urlToMarkdown(url!)
			pushToolResult(markdown)
		} finally {
			await task.urlContentFetcher.closeBrowser()
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"markdownify">): Promise<void> {
		const relPath = block.params.path ?? ""
		const absolutePath = relPath ? path.resolve(task.cwd, relPath) : undefined
		const partialMessage = JSON.stringify({
			tool: "markdownify",
			path: relPath ? getReadablePath(task.cwd, relPath) : undefined,
			url: block.params.url ?? undefined,
			content: "",
			isOutsideWorkspace: absolutePath ? isPathOutsideWorkspace(absolutePath) : false,
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const markdownifyTool = new MarkdownifyTool()
