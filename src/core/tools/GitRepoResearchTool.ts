import { type ClineSayTool } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import { searchCommits, getCommitInfo, getWorkingState } from "../../utils/git"
import type { ToolUse } from "../../shared/tools"

type Params = { action: "search_commits" | "get_commit_info" | "get_working_state"; query?: string }

function formatCommitSearchResults(commits: Awaited<ReturnType<typeof searchCommits>>): string {
	if (commits.length === 0) {
		return "No matching commits found."
	}

	return commits
		.map((commit, index) => `${index + 1}. ${commit.shortHash} — ${commit.subject}\n   ${commit.author} • ${commit.date}`)
		.join("\n\n")
}

export class GitRepoResearchTool extends BaseTool<"git_repo_research"> {
	readonly name = "git_repo_research" as const

	async execute(params: Params, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { action, query } = params
		const { askApproval, pushToolResult } = callbacks

		if ((action === "search_commits" || action === "get_commit_info") && !query) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "query"))
			return
		}

		const approval = JSON.stringify({
			tool: "gitRepoResearch",
			action,
			query,
			content: query || action,
		} satisfies ClineSayTool)
		const didApprove = await askApproval("tool", approval)
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0

		if (action === "search_commits") {
			pushToolResult(formatCommitSearchResults(await searchCommits(query!, task.cwd)))
			return
		}

		if (action === "get_commit_info") {
			pushToolResult(await getCommitInfo(query!, task.cwd))
			return
		}

		if (action === "get_working_state") {
			pushToolResult(await getWorkingState(task.cwd))
			return
		}

		const error = `Unsupported git_repo_research action: ${action}`
		await task.say("error", error)
		pushToolResult(formatResponse.toolError(error))
	}

	override async handlePartial(task: Task, block: ToolUse<"git_repo_research">): Promise<void> {
		const partialMessage = JSON.stringify({
			tool: "gitRepoResearch",
			action: block.params.action ?? "",
			query: block.params.query ?? "",
			content: "",
		} satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const gitRepoResearchTool = new GitRepoResearchTool()
