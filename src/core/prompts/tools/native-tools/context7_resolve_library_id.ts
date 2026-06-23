import type OpenAI from "openai"

const DESCRIPTION = `Searches Context7 for matching libraries and resolves a package or product name to a Context7-compatible library ID.

Parameters:
- libraryName: (required) Library or package name to search for
- query: (required) Specific user intent used to rank the best match

Use this before querying Context7 documentation when you do not already know the exact library ID.`

export default {
	type: "function",
	function: {
		name: "context7_resolve_library_id",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				libraryName: { type: "string", description: "Library or package name" },
				query: { type: "string", description: "Specific user intent used to rank results" },
			},
			required: ["libraryName", "query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
