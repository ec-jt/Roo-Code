import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "managed_environment",
		description: `Prepare, install, or inspect a new Roo-owned Python environment from a workspace manifest of exact, hashed binary wheels. Requires enabled and configured managed-environment settings. manifest_path is workspace relative (usually roo-environment.json). prepare validates and returns a read-only plan; status returns metadata inventory without executing Python; install requests approval of the exact packages, URLs, hashes, paths, fingerprint, and resource limits before creating a new environment. Only the user-configured root and Python executable may be used. No source builds, system installs, drivers, CUDA, existing-environment changes, deletion, activation, or arbitrary execution are supported. Separate automatic approval applies only to this operation, not package installs through execute_command. Do not bypass a rejection by using shell commands, another tool, or another environment. Installed third-party code may execute when the resulting interpreter is used later. Environments are external to workspace checkpoints and are not rolled back with workspace files.`,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["prepare", "install", "status"] },
				manifest_path: { type: "string", description: "Manifest path relative to the workspace." },
			},
			required: ["action", "manifest_path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionFunctionTool
