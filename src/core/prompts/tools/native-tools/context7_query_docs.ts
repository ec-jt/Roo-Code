import type OpenAI from "openai"

const DESCRIPTION = `Retrieves up-to-date Context7 documentation for a specific library.

Parameters:
- libraryId: (required) Exact Context7 library ID such as '/vercel/next.js'
- query: (required) Specific documentation question or topic to retrieve

Use this after resolving a library ID.`

export default {
	type: "function",
	function: {
		name: "context7_query_docs",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				libraryId: { type: "string", description: "Exact Context7 library ID" },
				query: { type: "string", description: "Specific documentation query" },
			},
			required: ["libraryId", "query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
