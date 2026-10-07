import type OpenAI from "openai"

const DESCRIPTION = `Converts a local file or a web page into markdown-friendly text.

Parameters:
- path: (optional) Relative path to a local file to convert
- url: (optional) URL of a web page to convert

Provide exactly one of path or url.

If conversion fails or times out, use another permitted retrieval method rather than repeatedly retrying this tool. For sustained investigation of a public paper or repository, prefer a bounded download into a task-specific research folder and search or extract the local source. Downloads require the normal command/write approvals and must not bypass access restrictions. Do not execute downloaded code.`

export default {
	type: "function",
	function: {
		name: "markdownify",
		description: DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: { type: ["string", "null"], description: "Relative path to a local file" },
				url: { type: ["string", "null"], description: "URL of a web page" },
			},
			required: ["path", "url"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
