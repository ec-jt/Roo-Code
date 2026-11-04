import * as vscode from "vscode"
import type { Task } from "../task/Task"
import type { ToolUse, PushToolResult } from "../../shared/tools"
import { acquireBrowserControl, browserControlFence } from "./browserControlAccess"
import { parseBrowserControlCommand } from "./browserControlCommand"
import { sanitizeBrowserUrl } from "../../services/browser/cdp/controlSecurity"

export const browserTranscriptWarning =
	"Browser results enter task history and model context. DOM, console text, network metadata and URL paths may contain secrets or untrusted instructions. Redaction is not guaranteed."

/** Read-only inspection. Mutations and tab selection always require explicit approval. */
const readOnlyActions = new Set([
	"status",
	"tabs",
	"snapshot",
	"console",
	"network",
	"inspect",
	"styles",
	"performance",
])

/** Per task and browser session. A new session or task must be approved again. */
const readOnlyApprovals = new WeakMap<Task, string>()

export function isReadOnlyBrowserControl(action: string): boolean {
	return readOnlyActions.has(action)
}

export async function browserControlTool(task: Task, block: ToolUse, pushToolResult: PushToolResult) {
	if (block.partial) return
	const command = parseBrowserControlCommand(
		block.nativeArgs && "command" in block.nativeArgs ? block.nativeArgs.command : block.params.command,
	)
	const release = acquireBrowserControl(task)
	try {
		const fence = browserControlFence(task)
		if (!fence.initial.capabilities[command.action])
			throw new Error("This command is unavailable on the active browser transport.")
		if ("sessionId" in command && command.sessionId !== fence.initial.sessionId)
			throw new Error("Browser command uses a stale session. Refresh status before retrying.")
		await fence.authorize(block)
		// The browser tool's auto-approval covers every rich command, including
		// mutations. Fences, capability checks and session checks still apply.
		const alreadyApproved =
			fence.isBrowserAutoApproved() ||
			(isReadOnlyBrowserControl(command.action) && readOnlyApprovals.get(task) === fence.initial.sessionId)
		if (alreadyApproved) {
			const result = await task.browserSession.control(command)
			fence.assert(false)
			if (result.state.sessionId !== fence.initial.sessionId)
				throw new Error(
					"Browser session changed during execution. Result discarded; do not retry automatically.",
				)
			result.warnings = command.action === "status" ? [] : [browserTranscriptWarning]
			await task.say("browser_action", JSON.stringify({ action: "control", controlAction: command.action }))
			fence.assert(false)
			await task.say("browser_action_result", JSON.stringify(result))
			fence.assert(false)
			pushToolResult(JSON.stringify(result))
			return
		}
		const review = {
			...command,
			...(command.action === "navigate" ? { url: sanitizeBrowserUrl(command.url) } : {}),
			...(command.action === "fill_ref" ? { text: `[${command.text.length} characters, not displayed]` } : {}),
			...(command.action === "select_ref" ? { values: `[${command.values.length} values, not displayed]` } : {}),
		}
		const answer = await vscode.window.showWarningMessage(
			"Approve browser control",
			{
				modal: true,
				detail: `${JSON.stringify(review, null, 2)}\n\nHost: ${fence.initial.extensionHost.hostname} (${fence.initial.extensionHost.platform}). Session: ${fence.initial.sessionId}. Selected tab: ${fence.initial.tabId ?? "none"}.\n${command.action === "status" ? "Status reads local session metadata only." : browserTranscriptWarning}\nApproval covers only this command. Selection authorizes subsequent separately approved interaction with that tab.`,
			},
			"Approve this command",
		)
		fence.assert()
		if (answer !== "Approve this command") {
			pushToolResult("Browser control denied. No browser command was executed.")
			return
		}
		if (isReadOnlyBrowserControl(command.action)) readOnlyApprovals.set(task, fence.initial.sessionId)
		await fence.authorize(block)
		const result = await task.browserSession.control(command)
		fence.assert(false)
		if (result.state.sessionId !== fence.initial.sessionId)
			throw new Error("Browser session changed during execution. Result discarded; do not retry automatically.")
		// The service warning describes sensitivity, not this transcript's persistence contract.
		result.warnings = command.action === "status" ? [] : [browserTranscriptWarning]
		await task.say("browser_action", JSON.stringify({ action: "control", controlAction: command.action }))
		fence.assert(false)
		await task.say("browser_action_result", JSON.stringify(result))
		fence.assert(false)
		pushToolResult(JSON.stringify(result))
	} finally {
		release()
	}
}
