import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { searchCommits, getCommitInfo, getWorkingState, getGitStatus } from "../../utils/git"
import type { ToolUse } from "../../shared/tools"

type Params = { action: "status" | "working_state" | "search_commits" | "commit_info"; query?: string }

function formatCommitSearchResults(commits: Awaited<ReturnType<typeof searchCommits>>): string {
	if (commits.length === 0) {
		return "No matching commits found."
	}

	return commits
		.map((commit, index) => `${index + 1}. ${commit.shortHash} — ${commit.subject}\n   ${commit.author} • ${commit.date}`)
		.join("\n\n")
}

export class GitToolsTool extends BaseTool<"git_tools"> {
	readonly name = "git_tools" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action, query } = params
		const { askApproval, pushToolResult } = callbacks

		if ((action === "search_commits" || action === "commit_info") && !query) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "query"))
			return
		}

		const approval = JSON.stringify({
			tool: "gitTools",
			action,
			query,
			content: query || action,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0

		if (action === "status") {
			pushToolResult((await getGitStatus(task.cwd, 50)) || "Not a git repository")
			return
		}

		if (action === "working_state") {
			pushToolResult(await getWorkingState(task.cwd))
			return
		}

		if (action === "search_commits") {
			pushToolResult(formatCommitSearchResults(await searchCommits(query!, task.cwd)))
			return
		}

		if (action === "commit_info") {
			pushToolResult(await getCommitInfo(query!, task.cwd))
			return
		}

		const error = `Unsupported git_tools action: ${action}`
		await task.say("error", error)
		pushToolResult(formatResponse.toolError(error))
	}

	override async handlePartial(task: Task, block: ToolUse<"git_tools">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "gitTools",
			action: block.params.action ?? "",
			query: block.params.query ?? "",
			content: "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const gitToolsTool = new GitToolsTool()
