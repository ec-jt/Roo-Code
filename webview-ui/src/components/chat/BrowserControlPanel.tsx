import { useEffect, useRef, useState } from "react"
import type { BrowserSessionRequest, BrowserSessionResponse, ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

const button = "rounded border border-vscode-panel-border px-2 py-1 disabled:opacity-50"

export function BrowserControlPanel({ taskId }: { taskId: string }) {
	return <BrowserControlPanelForTask key={taskId} taskId={taskId} />
}

function BrowserControlPanelForTask({ taskId }: { taskId: string }) {
	const [open, setOpen] = useState(false)
	const [response, setResponse] = useState<BrowserSessionResponse>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const pending = useRef<{ request: BrowserSessionRequest; timer: ReturnType<typeof setTimeout> }>()
	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const reply = event.data?.browserControlResponse
			const request = pending.current?.request
			if (
				event.data?.type !== "browserControlResponse" ||
				!reply ||
				!request ||
				reply.requestId !== request.requestId ||
				reply.taskId !== taskId ||
				(request.action !== "refresh" &&
					(reply.instanceId !== request.instanceId || reply.requestedSessionId !== request.sessionId))
			)
				return
			clearTimeout(pending.current!.timer)
			pending.current = undefined
			setBusy(false)
			if (reply.error) {
				setResponse(undefined)
				setError(reply.error)
			} else if (reply.cancelled) {
				setError("Session action cancelled. No browser command was executed.")
			} else {
				setResponse(reply)
				setError(undefined)
			}
		}
		window.addEventListener("message", receive)
		return () => {
			window.removeEventListener("message", receive)
			if (pending.current) clearTimeout(pending.current.timer)
		}
	}, [taskId])
	const send = (action: BrowserSessionRequest["action"], tabId?: string) => {
		if (pending.current) return
		if (typeof acquireVsCodeApi !== "function") {
			setError("Browser session controls require the native VS Code extension host.")
			return
		}
		const base = { requestId: crypto.randomUUID(), taskId }
		let request: BrowserSessionRequest
		if (action === "refresh") request = { ...base, action }
		else {
			if (!response?.state || !response.instanceId) return
			const session = { ...base, instanceId: response.instanceId, sessionId: response.state.sessionId }
			if (action === "select") {
				if (!tabId) return
				request = { ...session, action, tabId }
			} else request = { ...session, action }
		}
		setBusy(true)
		setError(undefined)
		pending.current = {
			request,
			timer: setTimeout(() => {
				pending.current = undefined
				setBusy(false)
				setResponse(undefined)
				setError("Request timed out. Refresh before retrying; an approved action may have completed.")
			}, 120_000),
		}
		vscode.postMessage({ type: "browserControlRequest", browserControlRequest: request })
	}
	const state = response?.state
	return (
		<section className="shrink-0 border-b border-vscode-panel-border px-3 py-1" aria-label="Browser controls">
			<button type="button" className={button} aria-expanded={open} onClick={() => setOpen(!open)}>
				Browser controls
			</button>
			{open && (
				<div className="flex max-h-80 flex-col gap-2 overflow-auto py-2 text-sm">
					<p>
						Snapshots can be stale. Refresh before reviewing an action. Tab controls require an idle
						foreground task and native confirmation.
					</p>
					<div className="flex flex-wrap gap-2">
						<button className={button} disabled={busy} onClick={() => send("refresh")}>
							Refresh status
						</button>
						<button className={button} disabled={busy || !state?.connected} onClick={() => send("tabs")}>
							List tabs
						</button>
						<button
							className={button}
							disabled={busy || !state?.connected}
							onClick={() => send("disconnect")}>
							Disconnect
						</button>
						<button
							className={button}
							disabled={busy || !state || state.connected || state.transport === "chrome-extension"}
							onClick={() => send("start_bridge")}>
							Start Chrome bridge
						</button>
						<button
							className={button}
							disabled={busy || state?.transport !== "chrome-extension"}
							onClick={() => send("stop_bridge")}>
							Stop Chrome bridge
						</button>
						<button
							className={button}
							disabled={busy || !state || state.ownership !== "none" || state.transport !== "cdp"}
							onClick={() => send("start_certificate_session")}>
							Review isolated certificate exception
						</button>
					</div>
					{busy && <p role="status">Waiting for native review or browser response.</p>}
					{error && <p role="alert">{error}</p>}
					{state && (
						<>
							<p>
								Extension host: {state.extensionHost.hostname}, {state.extensionHost.platform},{" "}
								{state.extensionHost.remoteName || "local"}
							</p>
							<p>
								Transport: {state.transport}. {state.connected ? "Connected" : "Disconnected"}.
								Ownership: {state.ownership}.
							</p>
							<p className="break-all">
								Session: {state.sessionId}. Selected tab: {state.tabId || "none"}.
							</p>
							<p>
								TLS:{" "}
								{state.certificatePolicy === "isolated-session-exception"
									? "WARNING: all invalid certificates are accepted in this isolated Roo-owned session. Disconnect to revoke."
									: "Verification enabled. Prefer fixing the certificate chain, hostname, expiry, clock or browser trust store. Attached browsers cannot receive an exception."}
							</p>
							<p>
								Available:{" "}
								{Object.entries(state.capabilities)
									.filter(([, enabled]) => enabled)
									.map(([name]) => name)
									.join(", ")}
							</p>
							<p>
								Unavailable:{" "}
								{Object.entries(state.capabilities)
									.filter(([, enabled]) => !enabled)
									.map(([name]) => name)
									.join(", ")}
							</p>
						</>
					)}
					<p>
						Tab URLs omit credentials, query and fragment, but paths can contain secrets. Approved model
						browser results enter task history and model context.
					</p>
					{response?.tabs?.map((tab) => (
						<div key={tab.id} className="flex flex-col gap-1 border-t border-vscode-panel-border py-1">
							<span className="break-all">{tab.url}</span>
							<span className="break-all">
								{tab.id} ({tab.owned ? "Roo-owned" : "attached"}) {tab.selected ? "selected" : ""}
							</span>
							<button
								className={button}
								disabled={busy || tab.selected}
								onClick={() => send("select", tab.id)}>
								Select tab
							</button>
						</div>
					))}
					<p>
						Dedicated CDP uses the existing browser settings. The optional unpacked Chrome companion
						attaches only a tab you explicitly authorize in its popup. Pairing secrets appear only in native
						dialogs.
					</p>
				</div>
			)}
		</section>
	)
}
