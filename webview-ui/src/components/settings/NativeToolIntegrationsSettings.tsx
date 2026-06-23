import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

/**
 * Catalog of native tools surfaced in the settings panel. Each entry maps a
 * tool name (the canonical function name the model invokes) to display info
 * and any credentials it depends on. Tools not listed here are still
 * enabled by default; this panel only surfaces the ones users typically want
 * to toggle or configure.
 */
type ToolInfo = {
	name: string
	label: string
	description: string
	// Optional credential dependency — when set, the tool is informational-only
	// unless the linked credential is populated.
	requiresCredential?: "brave" | "context7" | "github"
}

const TOOL_CATALOG: ToolInfo[] = [
	{
		name: "brave_web_search",
		label: "Brave Web Search",
		description: "General web search via Brave Search API. Use for broad discovery and recent information.",
		requiresCredential: "brave",
	},
	{
		name: "brave_local_search",
		label: "Brave Local Search",
		description: "Local businesses and places (e.g. 'pizza near Central Park') via Brave Search API.",
		requiresCredential: "brave",
	},
	{
		name: "context7_resolve_library_id",
		label: "Context7 — Resolve Library ID",
		description: "Find a Context7 library ID by package or product name (e.g. 'next.js' → '/vercel/next.js').",
		requiresCredential: "context7",
	},
	{
		name: "context7_query_docs",
		label: "Context7 — Query Docs",
		description: "Fetch up-to-date library documentation by Context7 library ID.",
		requiresCredential: "context7",
	},
	{
		name: "file_system",
		label: "File System",
		description: "Unified workspace file ops: read_text_file, list_directory, search_files (regex + glob).",
	},
	{
		name: "markdownify",
		label: "Markdownify",
		description: "Convert a local file or a web page to markdown-friendly text. Provide exactly one of path or url.",
	},
	{
		name: "git_tools",
		label: "Git Tools",
		description:
			"Inspect the workspace git repo: status, working_state, search_commits, commit_info. Uses the GitHub PAT for private remotes when available.",
		requiresCredential: "github",
	},
	{
		name: "git_repo_research",
		label: "Git Repo Research",
		description:
			"Historical research on the workspace git repo: search_commits, get_commit_info, get_working_state. Uses the GitHub PAT for private remotes when available.",
		requiresCredential: "github",
	},
]

type NativeToolIntegrationsSettingsProps = {
	braveApiKey?: string
	context7ApiKey?: string
	githubToken?: string
	nativeToolEnabled?: Record<string, boolean>
	setBraveApiKey: (apiKey: string) => void
	setContext7ApiKey: (apiKey: string) => void
	setGithubToken?: (token: string) => void
	setNativeToolEnabled?: (map: Record<string, boolean>) => void
}

// Unset (undefined) = enabled by default.
const isToolEnabled = (map: Record<string, boolean> | undefined, name: string): boolean => {
	if (!map) return true
	const v = map[name]
	return v !== false
}

export const NativeToolIntegrationsSettings = ({
	braveApiKey,
	context7ApiKey,
	githubToken,
	nativeToolEnabled,
	setBraveApiKey,
	setContext7ApiKey,
	setGithubToken,
	setNativeToolEnabled,
}: NativeToolIntegrationsSettingsProps) => {
	const setToolEnabled = (name: string, enabled: boolean) => {
		if (!setNativeToolEnabled) return
		const next = { ...(nativeToolEnabled ?? {}) }
		if (enabled) {
			// Default is enabled, so removing the key is equivalent and keeps the map small.
			delete next[name]
		} else {
			next[name] = false
		}
		setNativeToolEnabled(next)
	}

	return (
		<div className="space-y-6">
			<div>
				<div className="font-medium mb-1">Native Tool Integrations</div>
				<p className="text-vscode-descriptionForeground text-sm mt-0">
					Configure built-in (first-party) tools. Each tool can be enabled or disabled individually. Tools
					that need an API key or token are wired up here; the keys are stored in VS Code Secret Storage.
				</p>
			</div>

			<div className="space-y-4">
				<div className="font-medium">Credentials</div>

				<div>
					<label className="block font-medium mb-1">Brave Search API Key</label>
					<VSCodeTextField
						value={braveApiKey || ""}
						onInput={(e: any) => setBraveApiKey(e.target.value)}
						placeholder="Enter Brave Search API key..."
						className="w-full"
						type="password"
					/>
					<p className="text-vscode-descriptionForeground text-xs mt-1">
						Required for <code>brave_web_search</code> and <code>brave_local_search</code>. Sign up at
						brave.com/search/api.
					</p>
				</div>

				<div>
					<label className="block font-medium mb-1">Context7 API Key</label>
					<VSCodeTextField
						value={context7ApiKey || ""}
						onInput={(e: any) => setContext7ApiKey(e.target.value)}
						placeholder="Enter Context7 API key..."
						className="w-full"
						type="password"
					/>
					<p className="text-vscode-descriptionForeground text-xs mt-1">
						Required for <code>context7_resolve_library_id</code> and <code>context7_query_docs</code>.
					</p>
				</div>

				<div>
					<label className="block font-medium mb-1">GitHub Personal Access Token (PAT)</label>
					<VSCodeTextField
						value={githubToken || ""}
						onInput={(e: any) => setGithubToken?.(e.target.value)}
						placeholder="ghp_… or github_pat_…"
						className="w-full"
						type="password"
					/>
					<p className="text-vscode-descriptionForeground text-xs mt-1">
						Used by <code>git_tools</code> and <code>git_repo_research</code> when the workspace remote
						points at a private GitHub repository. The token is injected via the{" "}
						<code>GH_TOKEN</code> environment variable so <code>git</code> can fetch private history.
						Required scopes: <code>repo</code> (private repo access). Leave empty for public-only repos.
					</p>
				</div>
			</div>

			<div className="space-y-3">
				<div className="font-medium">Tools</div>
				<p className="text-vscode-descriptionForeground text-xs">
					All tools are enabled by default. Untick any that you do not want the agent to call. Tools whose
					required credential is missing are disabled automatically until you provide the key above.
				</p>
				{TOOL_CATALOG.map((tool) => {
					const enabled = isToolEnabled(nativeToolEnabled, tool.name)
					const credentialMissing =
						(tool.requiresCredential === "brave" && !braveApiKey) ||
						(tool.requiresCredential === "context7" && !context7ApiKey) ||
						(tool.requiresCredential === "github" && !githubToken)
					return (
						<div key={tool.name} className="ml-1">
							<VSCodeCheckbox
								checked={enabled}
								disabled={credentialMissing}
								onChange={(e: any) => setToolEnabled(tool.name, !!e.target.checked)}>
								<span className="font-medium">{tool.label}</span>{" "}
								<code className="text-xs text-vscode-descriptionForeground">{tool.name}</code>
							</VSCodeCheckbox>
							<p className="text-vscode-descriptionForeground text-xs mt-0.5 ml-6">
								{tool.description}
								{credentialMissing && (
									<>
										{" "}
										<span className="text-vscode-errorForeground">
											(missing {tool.requiresCredential} credential — disabled)
										</span>
									</>
								)}
							</p>
						</div>
					)
				})}
			</div>
		</div>
	)
}
