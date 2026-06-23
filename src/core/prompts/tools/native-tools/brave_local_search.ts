import type OpenAI from "openai"

const DESCRIPTION = `Searches for local businesses and places using Brave Search.

Parameters:
- query: (required) Local search query such as 'pizza near Central Park'
- count: (optional) Number of results to return

Use this when the query implies places, local businesses, addresses, or nearby results.`

export default {
	type: "function",
	function: {
		name: "brave_local_search",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Local search query" },
				count: { type: ["number", "null"], description: "Optional number of results" },
			},
			required: ["query", "count"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
