import type OpenAI from "openai"

const DESCRIPTION = `Inspects the current workspace Git repository using built-in Roo capabilities.

Parameters:
- action: (required) One of 'status', 'working_state', 'search_commits', or 'commit_info'
- query: (optional) Commit hash or search query required for certain actions

Use this for native Git inspection without relying on an external MCP server.`

export default {
	type: "function",
	function: {
		name: "git_tools",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["status", "working_state", "search_commits", "commit_info"],
					description: "Git inspection action",
				},
				query: { type: ["string", "null"], description: "Commit hash or search query" },
			},
			required: ["action", "query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
