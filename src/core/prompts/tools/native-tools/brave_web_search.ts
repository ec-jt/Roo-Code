import type OpenAI from "openai"

const DESCRIPTION = `Performs a web search using Brave Search API.

Parameters:
- query: (required) Search query
- count: (optional) Number of results to return
- offset: (optional) Pagination offset

Use this for broad web searches, recent information, and content discovery.`

export default {
	type: "function",
	function: {
		name: "brave_web_search",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				count: { type: ["number", "null"], description: "Optional number of results" },
				offset: { type: ["number", "null"], description: "Optional pagination offset" },
			},
			required: ["query", "count", "offset"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
