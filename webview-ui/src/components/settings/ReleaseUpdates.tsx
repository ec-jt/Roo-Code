import { useEffect, useState } from "react"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import type { ExtensionMessage, ReleaseUpdateState, WebviewMessage } from "@roo-code/types"
import { Button } from "@/components/ui"
import { vscode } from "@/utils/vscode"

export function ReleaseUpdates() {
	const [state, setState] = useState<ReleaseUpdateState>()
	const send = (action: WebviewMessage["releaseUpdateAction"]) =>
		vscode.postMessage({ type: "releaseUpdateAction", releaseUpdateAction: action })
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type === "releaseUpdateState" && event.data.releaseUpdateState)
				setState(event.data.releaseUpdateState)
		}
		window.addEventListener("message", receive)
		vscode.postMessage({ type: "releaseUpdateAction", releaseUpdateAction: "status" })
		return () => window.removeEventListener("message", receive)
	}, [])
	const busy = state && ["checking", "downloading", "installing"].includes(state.phase)
	return (
		<div className="space-y-3">
			<h3>GitHub release updates</h3>
			<p className="text-sm text-vscode-descriptionForeground">
				Source:{" "}
				<VSCodeLink href="https://github.com/ec-jt/Roo-Code/releases">ec-jt/Roo-Code releases</VSCodeLink>,
				including experimental Cordis previews. Updates are downloaded and verified on the current extension
				host.
			</p>
			{state && (
				<p className="text-sm">
					{state.host} · Running {state.currentVersion}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button disabled={!state || busy || !!state.installedVersion} onClick={() => send("check")}>
					Check for updates
				</Button>
				<Button disabled={!state || busy || !!state.installedVersion} onClick={() => send("install")}>
					Update / install latest
				</Button>
				{busy && state.phase !== "installing" && (
					<Button variant="secondary" onClick={() => send("cancel")}>
						Cancel update
					</Button>
				)}
				{state?.installedVersion && <Button onClick={() => send("reload")}>Reload to activate</Button>}
			</div>
			<VSCodeCheckbox
				checked={state?.automatic ?? false}
				disabled={!state}
				onChange={(event: any) => send(event.target.checked === true ? "enableAutomatic" : "disableAutomatic")}>
				Automatically install GitHub release updates
			</VSCodeCheckbox>
			<p className="text-xs text-vscode-descriptionForeground">
				Off by default. Enabling requires confirmation on this host and takes effect immediately. Checks at
				startup and every six hours. Installation waits until all Roo tasks are closed. Reload is always manual.
			</p>
			<p className="text-sm" role="status">
				{state?.message ?? "Loading updater status…"}
			</p>
			{state?.releaseUrl && (
				<VSCodeLink href={state.releaseUrl}>
					Read release notes{state.availableVersion ? ` for ${state.availableVersion}` : ""}
				</VSCodeLink>
			)}
			<p className="text-xs text-vscode-descriptionForeground">
				VS Code Marketplace auto-update is separate. Disable marketplace auto-update for this extension if you
				want only releases from this fork. This does not uninstall Roo or remove tasks/settings. Close the loaded
				task before installing or reloading. Remote SSH and local installations must be updated separately.
			</p>
		</div>
	)
}
