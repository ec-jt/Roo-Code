import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

type NativeToolIntegrationsSettingsProps = {
	braveApiKey?: string
	context7ApiKey?: string
	setBraveApiKey: (apiKey: string) => void
	setContext7ApiKey: (apiKey: string) => void
}

export const NativeToolIntegrationsSettings = ({
	braveApiKey,
	context7ApiKey,
	setBraveApiKey,
	setContext7ApiKey,
}: NativeToolIntegrationsSettingsProps) => {
	return (
		<div className="space-y-4">
			<div>
				<div className="font-medium mb-1">Native Tool Integrations</div>
				<p className="text-vscode-descriptionForeground text-sm mt-0">
					Configure first-party API-backed tools for Brave Search and Context7. These keys are stored securely in
					VS Code Secret Storage.
				</p>
			</div>

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
					Used by the native <code>brave_web_search</code> and <code>brave_local_search</code> tools.
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
					Used by the native <code>context7_resolve_library_id</code> and <code>context7_query_docs</code> tools.
				</p>
			</div>
		</div>
	)
}
