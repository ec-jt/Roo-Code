import { type ClineSayTool } from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { context7QueryDocs, formatContext7DocsResponse } from "../../services/native-tools/context7"
import type { ToolUse } from "../../shared/tools"

type Params = { libraryId: string; query: string }

export class Context7QueryDocsTool extends BaseTool<"context7_query_docs"> {
	readonly name = "context7_query_docs" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { libraryId, query } = params
		const { askApproval, pushToolResult } = callbacks
		const state = await task.providerRef.deref()?.getState()
		const apiKey = state?.context7ApiKey

		if (!libraryId) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "libraryId"))
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
			tool: "context7QueryDocs",
			query,
			content: libraryId,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0
		const result = await context7QueryDocs(apiKey, libraryId, query)
		pushToolResult(formatContext7DocsResponse(result))
	}

	override async handlePartial(task: Task, block: ToolUse<"context7_query_docs">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "context7QueryDocs",
			query: block.params.query ?? "",
			content: block.params.libraryId ?? "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const context7QueryDocsTool = new Context7QueryDocsTool()
