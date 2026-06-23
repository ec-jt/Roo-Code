import { type ClineSayTool } from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { braveSearch, formatBraveLocalSearchResponse } from "../../services/native-tools/brave"
import type { ToolUse } from "../../shared/tools"

type Params = { query: string; count?: number }

export class BraveLocalSearchTool extends BaseTool<"brave_local_search"> {
	readonly name = "brave_local_search" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { query, count } = params
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

		const approval = JSON.stringify({ tool: "braveLocalSearch", query, content: query } satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0
		const result = await braveSearch(apiKey, query, count)
		pushToolResult(formatBraveLocalSearchResponse(result))
	}

	override async handlePartial(task: Task, block: ToolUse<"brave_local_search">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "braveLocalSearch",
			query: block.params.query ?? "",
			content: "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const braveLocalSearchTool = new BraveLocalSearchTool()
