import type OpenAI from "openai"

const DESCRIPTION = `Researches the current workspace Git repository using built-in Roo capabilities.

Parameters:
- action: (required) One of 'search_commits', 'get_commit_info', or 'get_working_state'
- query: (optional) Commit hash or search query required for certain actions

Use this for historical Git research without relying on an external MCP server.`

export default {
	type: "function",
	function: {
		name: "git_repo_research",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["search_commits", "get_commit_info", "get_working_state"],
					description: "Git repository research action",
				},
				query: { type: ["string", "null"], description: "Commit hash or search query" },
			},
			required: ["action", "query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
