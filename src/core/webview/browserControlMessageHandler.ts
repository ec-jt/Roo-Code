import * as vscode from "vscode"
import type { ClineProvider } from "./ClineProvider"
import {
	browserSessionRequestSchema,
	type BrowserSessionResponse,
} from "../../../packages/types/src/browser-session-protocol"
import { acquireBrowserControl, browserControlFence } from "../tools/browserControlAccess"
import { sanitizeBrowserUrl } from "../../services/browser/cdp/controlSecurity"

/** Native-only, bounded session metadata protocol. No panel-supplied CDP commands. */
export async function handleBrowserControlRequest(provider: ClineProvider, raw: unknown): Promise<void> {
	const parsed = browserSessionRequestSchema.safeParse(raw)
	if (!parsed.success) return
	const request = parsed.data
	const response: BrowserSessionResponse = {
		requestId: request.requestId,
		taskId: request.taskId,
		requestedSessionId: "sessionId" in request ? request.sessionId : undefined,
	}
	let release: (() => void) | undefined
	try {
		const task = provider.getCurrentTask()
		if (!task || task.taskId !== request.taskId) throw new Error("Task changed. Refresh the foreground task.")
		response.instanceId = task.instanceId
		release = acquireBrowserControl(task)
		const fence = browserControlFence(task, request.action !== "refresh")
		if (request.action === "refresh") {
			// Local metadata only, no browser enumeration or page access.
			response.state = fence.initial
		} else {
			if (request.instanceId !== task.instanceId || request.sessionId !== fence.initial.sessionId)
				throw new Error("Browser session changed. Refresh before retrying.")
			await fence.authorize()
			const answer = await vscode.window.showWarningMessage(
				request.action === "start_bridge"
					? "Start private Chrome extension bridge"
					: request.action === "start_certificate_session"
						? "Review isolated certificate exception"
						: "Review browser session action",
				{
					modal: true,
					detail: `Action: ${request.action}. Task: ${task.taskId}. Session: ${request.sessionId}. Host: ${fence.initial.extensionHost.hostname} (${fence.initial.extensionHost.platform}).\n${request.action === "select" ? `Select tab ${request.tabId} for subsequent separately approved model interaction. ` : ""}${request.action === "start_bridge" ? "Start an ephemeral authenticated listener on this host's 127.0.0.1 and authorize one Chrome extension ID. The companion has powerful debugger permission. Explicit popup attachment and separate command approvals are still required. Never copy the pairing secret to chat. No tunnel or browser discovery is created." : request.action === "disconnect" || request.action === "stop_bridge" ? "Disconnect revokes the bridge or detaches an attached browser without closing user tabs. Roo-owned sessions are closed." : "Tab enumeration exposes sanitized URLs to this panel. URL paths can contain secrets. Selecting a tab enables subsequent DOM, console and network access according to transport capabilities; approved model tool results enter task history and model context."}\nOnly this action is approved.`,
				},
				"Approve session action",
			)
			fence.assert()
			if (answer !== "Approve session action") {
				response.cancelled = true
			} else {
				await fence.authorize()
				if (request.action === "start_certificate_session") {
					if (fence.initial.ownership !== "none" || fence.initial.transport !== "cdp")
						throw new Error(
							"Disconnect the browser first. Certificate exceptions cannot affect attached sessions.",
						)
					const approved = await vscode.window.showWarningMessage(
						"Disable certificate verification in a new isolated local browser?",
						{
							modal: true,
							detail: `This launches a fresh Roo-owned process and temporary profile on ${fence.initial.extensionHost.hostname} (${fence.initial.extensionHost.platform}). It accepts ALL invalid TLS certificates for the ENTIRE browser session, including redirects and subresources. It is NOT a hostname-specific exception or certificate pin. Prefer installing the correct internal CA or fixing the certificate. Do not use personal accounts or unrelated sites in this session. Disconnect closes the browser and removes its temporary profile. Remote CDP and Chrome companion sessions are not eligible. This approval does not authorize BIOS changes, power operations, form submission, or other site mutations. No page is opened by this action.`,
						},
						"Launch isolated exception session",
					)
					await fence.authorize()
					if (approved !== "Launch isolated exception session") response.cancelled = true
					else {
						await task.browserSession.launchIsolatedCertificateSession(() => fence.authorize())
						try {
							fence.assert(false, false)
							response.state = task.browserSession.getControlState()
						} catch (error) {
							await task.browserSession.closeBrowser()
							throw error
						}
					}
				} else if (request.action === "start_bridge") {
					if (fence.initial.connected || fence.initial.transport === "chrome-extension")
						throw new Error("Disconnect the existing transport before starting the bridge.")
					const extensionId = await vscode.window.showInputBox({
						title: "Authorize Chrome companion extension",
						prompt: "Enter the exact 32-character extension ID from the unpacked Roo companion popup. Only this extension origin can pair. The listener binds this host's 127.0.0.1, not the remote desktop's loopback.",
						ignoreFocusOut: true,
						validateInput: (value) =>
							/^[a-p]{32}$/.test(value) ? undefined : "Enter a Chrome extension ID (32 letters a-p).",
					})
					await fence.authorize()
					if (!extensionId) {
						response.cancelled = true
					} else {
						const credentials = await task.browserSession.startExtensionBridge(extensionId)
						try {
							fence.assert(false, false)
							// Native input only. Never return credentials in response, errors, logs, or task history.
							const accepted = await vscode.window.showInputBox({
								title: "Private Chrome bridge pairing (expires in two minutes)",
								prompt: `Endpoint: ${credentials.endpoint}. Copy the secret into the companion popup, then choose Pair and attach active tab. Enter keeps the listener; Escape revokes it. Do not paste credentials into chat.`,
								value: credentials.secret,
								ignoreFocusOut: true,
							})
							fence.assert(false, false)
							await browserControlFence(task, true).authorize()
							if (accepted === undefined) {
								await task.browserSession.closeBrowser()
								response.cancelled = true
							}
							response.state = task.browserSession.getControlState()
						} catch {
							await task.browserSession.closeBrowser()
							throw new Error("Pairing cancelled or task changed. Bridge revoked.")
						}
					}
				} else if (request.action === "disconnect" || request.action === "stop_bridge") {
					if (request.action === "stop_bridge" && fence.initial.transport !== "chrome-extension")
						throw new Error("No Chrome extension bridge is active.")
					await task.browserSession.closeBrowser()
					fence.assert(false, false)
					const state = task.browserSession.getControlState()
					if (state.connected)
						throw new Error("Browser session changed during disconnect. Refresh before retrying.")
					response.state = state
				} else {
					const result = await task.browserSession.control(
						request.action === "tabs"
							? { action: "tabs" }
							: { action: "select_tab", sessionId: request.sessionId, tabId: request.tabId },
					)
					fence.assert(false)
					if (result.state.sessionId !== request.sessionId)
						throw new Error("Browser session changed during execution. Refresh before retrying.")
					if (!result.ok) throw new Error(result.error?.message ?? "Browser action failed.")
					response.state = result.state
					response.tabs = result.data?.tabs?.map((tab) => ({ ...tab, url: sanitizeBrowserUrl(tab.url) }))
				}
			}
		}
	} catch (error) {
		response.error = error instanceof Error ? error.message : "Browser session action failed."
	} finally {
		release?.()
	}
	await provider.postMessageToWebview({ type: "browserControlResponse", browserControlResponse: response })
}
