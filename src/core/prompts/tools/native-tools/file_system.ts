import type OpenAI from "openai"

const DESCRIPTION = `Provides first-party file system operations built directly into Roo.

Parameters:
- action: (required) One of 'read_text_file', 'list_directory', or 'search_files'
- path: (required) File or directory path relative to the workspace
- regex: (optional) Regex used when action is 'search_files'
- file_pattern: (optional) Glob filter used when action is 'search_files'
- recursive: (optional) Whether to recurse when action is 'list_directory'

Use this as a unified native wrapper around Roo's existing file system capabilities.`

export default {
	type: "function",
	function: {
		name: "file_system",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["read_text_file", "list_directory", "search_files"],
					description: "Requested file system action",
				},
				path: { type: "string", description: "File or directory path" },
				regex: { type: ["string", "null"], description: "Regex for search_files" },
				file_pattern: { type: ["string", "null"], description: "Optional glob for search_files" },
				recursive: { type: ["boolean", "null"], description: "Whether to recurse for list_directory" },
			},
			required: ["action", "path", "regex", "file_pattern", "recursive"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
