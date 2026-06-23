import { type ClineSayTool } from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { context7ResolveLibraryId, formatContext7SearchResponse } from "../../services/native-tools/context7"
import type { ToolUse } from "../../shared/tools"

type Params = { libraryName: string; query: string }

export class Context7ResolveLibraryIdTool extends BaseTool<"context7_resolve_library_id"> {
	readonly name = "context7_resolve_library_id" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { libraryName, query } = params
		const { askApproval, pushToolResult } = callbacks
		const state = await task.providerRef.deref()?.getState()
		const apiKey = state?.context7ApiKey

		if (!libraryName) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "libraryName"))
			return
		}

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "query"))
			return
		}

		if (!apiKey) {
			const error = "Context7 API key is not configured in Settings → Experimental → Native Tool Integrations."
			await task.say("error", error)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(error))
			return
		}

		const approval = JSON.stringify({
			tool: "context7ResolveLibraryId",
			query,
			content: libraryName,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0
		const result = await context7ResolveLibraryId(apiKey, libraryName, query)
		pushToolResult(formatContext7SearchResponse(result))
	}

	override async handlePartial(task: Task, block: ToolUse<"context7_resolve_library_id">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "context7ResolveLibraryId",
			query: block.params.query ?? "",
			content: block.params.libraryName ?? "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const context7ResolveLibraryIdTool = new Context7ResolveLibraryIdTool()
