import { type ClineSayTool } from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { braveSearch, formatBraveWebSearchResponse } from "../../services/native-tools/brave"
import type { ToolUse } from "../../shared/tools"

type Params = { query: string; count?: number; offset?: number }

export class BraveWebSearchTool extends BaseTool<"brave_web_search"> {
	readonly name = "brave_web_search" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { query, count, offset } = params
		const { askApproval, pushToolResult } = callbacks
		const state = await task.providerRef.deref()?.getState()
		const apiKey = state?.braveApiKey

		if (!query) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "query"))
			return
		}

		if (!apiKey) {
			const error = "Brave Search API key is not configured in Settings → Experimental → Native Tool Integrations."
			await task.say("error", error)
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(error))
			return
		}

		const approval = JSON.stringify({ tool: "braveWebSearch", query, content: query } satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0
		const result = await braveSearch(apiKey, query, count, offset)
		pushToolResult(formatBraveWebSearchResponse(result))
	}

	override async handlePartial(task: Task, block: ToolUse<"brave_web_search">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "braveWebSearch",
			query: block.params.query ?? "",
			content: "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const braveWebSearchTool = new BraveWebSearchTool()
