import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	isComputerAction,
	readOnlyComputerActions,
	type ClineSayComputerAction,
	type ComputerAction,
	type ComputerActionParams,
	type ComputerActionResult,
} from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

import { checkPlatform, formatPlatformCheckFailure } from "../../services/desktop/platformCheck"
import { getDesktopSession } from "../../services/desktop/sessionRegistry"
import { ComputerActionError, isWindowAllowed } from "../../services/desktop/DesktopSession"
import { DesktopUnsupportedError } from "../../services/desktop/libnutLoader"
import { getDesktopActivityIndicator } from "../../services/desktop/activityIndicator"

/** Required parameters per action, checked before approval so the user is never asked to approve an invalid call. */
const REQUIRED_PARAMS: Partial<Record<ComputerAction, (keyof ComputerActionParams)[]>> = {
	click: ["coordinate"],
	double_click: ["coordinate"],
	right_click: ["coordinate"],
	move: ["coordinate"],
	drag: ["coordinate", "end_coordinate"],
	type: ["text"],
	key: ["key"],
	focus_window: ["window"],
	window_screenshot: ["window"],
	window_type: ["window", "text"],
}

/** Actions whose target is the window named in params.window, not the active window. */
const WINDOW_TARGETED: ReadonlySet<string> = new Set(["focus_window", "window_type"])

function isReadOnly(action: ComputerAction): boolean {
	return (readOnlyComputerActions as readonly string[]).includes(action)
}

/** Strip nulls the model may send for optional params. */
function normalizeParams(raw: Record<string, unknown>): ComputerActionParams {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(raw ?? {})) {
		if (value === null || value === undefined) continue
		out[key] = typeof value === "string" ? value : String(value)
	}
	return out as unknown as ComputerActionParams
}

function toSayPayload(params: ComputerActionParams): ClineSayComputerAction {
	return {
		action: params.action,
		coordinate: params.coordinate,
		endCoordinate: params.end_coordinate,
		text: params.text,
		key: params.key,
		direction: params.direction,
		amount: params.amount !== undefined ? Number(params.amount) : undefined,
		window: params.window,
		duration: params.duration !== undefined ? Number(params.duration) : undefined,
	}
}

export class ComputerActionTool extends BaseTool<"computer_action"> {
	readonly name = "computer_action" as const

	async execute(rawParams: ComputerActionParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const params = normalizeParams(rawParams as unknown as Record<string, unknown>)

		const fail = async (message: string) => {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			task.didToolFailInCurrentTurn = true
			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message))
		}

		// 1. Validate the action and its required params.
		if (!params.action) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, "action"))
			return
		}
		if (!isComputerAction(params.action)) {
			await fail(`Unknown computer_action "${params.action}".`)
			return
		}
		for (const name of REQUIRED_PARAMS[params.action] ?? []) {
			if (!params[name]) {
				task.consecutiveMistakeCount++
				task.recordToolError(this.name)
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError(this.name, name))
				return
			}
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const extensionPath = provider?.context?.extensionPath

		// 2. Feature gate. The tool is also removed from the prompt when disabled; this guards stale calls.
		if (state?.computerUseEnabled !== true) {
			await fail("Desktop control is turned off. The user can enable it in Settings > Computer Use.")
			return
		}
		if (!extensionPath) {
			await fail("Desktop control is unavailable: the extension path could not be determined.")
			return
		}

		// 3. Environment pre-flight (remote host, platform, display server, macOS permissions).
		const check = checkPlatform({ remoteName: vscode.env.remoteName, extensionPath })
		if (!check.ok) {
			await fail(formatPlatformCheckFailure(check))
			return
		}

		try {
			const session = getDesktopSession(task, extensionPath)

			// 4. App allowlist. Read-only actions are always allowed; state-changing actions
			//    require the target window (focus_window) or the active window to match.
			const allowlist = state.computerUseAllowedApps ?? []
			if (!isReadOnly(params.action) && allowlist.some((e) => e.trim())) {
				const targetTitle = WINDOW_TARGETED.has(params.action)
					? session.findWindow(params.window).title
					: session.getActiveWindowTitle()

				if (!isWindowAllowed(targetTitle, allowlist)) {
					await fail(
						`The window "${targetTitle ?? "unknown"}" is not in the Computer Use app allowlist (${allowlist.join(", ")}). ` +
							"Use focus_window to switch to an allowed app, or ask the user to update the allowlist.",
					)
					return
				}
			}

			// 5. Approval. Auto-approval for computer_action is decided in checkAutoApproval
			//    and requires the dedicated alwaysAllowComputerUse opt-in.
			const didApprove = await askApproval("computer_action", JSON.stringify(toSayPayload(params)))
			if (!didApprove) {
				return
			}

			task.consecutiveMistakeCount = 0

			// The user may have pressed Stop while the approval prompt was open.
			if (task.abort) {
				return
			}

			// 6. Execute, with the status bar indicator visible for the duration.
			const endActivity = getDesktopActivityIndicator().begin(params.action)
			let result: Awaited<ReturnType<typeof session.execute>>
			try {
				result = await session.execute(params)
			} finally {
				endActivity()
			}

			await task.say(
				"computer_action",
				JSON.stringify({ ...toSayPayload(params), executedCoordinate: result.executedCoordinate }),
				undefined,
				false,
			)
			await task.say("computer_action_result", JSON.stringify(result satisfies ComputerActionResult))

			pushToolResult(this.formatResult(params, result, task, check.warnings))
		} catch (error) {
			if (error instanceof ComputerActionError || error instanceof DesktopUnsupportedError) {
				await fail(error.message)
				return
			}
			await handleError("executing computer action", error instanceof Error ? error : new Error(String(error)))
		}
	}

	private formatResult(
		params: ComputerActionParams,
		result: ComputerActionResult & { executedCoordinate?: string },
		task: Task,
		warnings: string[],
	) {
		const lines: string[] = []

		if (params.action === "list_windows") {
			const windows = result.windows ?? []
			lines.push(`Open windows (${windows.length}):`)
			for (const w of windows) {
				lines.push(
					`- id ${w.id}${w.active ? " (active)" : ""}: "${w.title}" at ${w.x},${w.y} size ${w.width}x${w.height}`,
				)
			}
			lines.push(
				"",
				"Window positions are in screen points, not screenshot pixels. Take a screenshot before clicking.",
			)
		} else {
			lines.push(params.action === "screenshot" ? "Screenshot taken." : `Action "${params.action}" executed.`)
			if (result.windowTitle) {
				lines.push(
					`The image shows only the window "${result.windowTitle}". Its pixels are not screen coordinates: do not use them for click, move, drag, or scroll.`,
				)
			} else if (result.screenshotWidth && result.screenshotHeight) {
				lines.push(
					`Screenshot size: ${result.screenshotWidth}x${result.screenshotHeight}. Give coordinates as "x,y" in this image's pixels.`,
				)
			}
			if (result.cursorPosition) lines.push(`Cursor: ${result.cursorPosition}`)
			if (result.activeWindowTitle) lines.push(`Active window: "${result.activeWindowTitle}"`)
		}

		for (const warning of warnings) lines.push(`Note: ${warning}`)

		const supportsImages = task.api.getModel().info.supportsImages ?? false
		if (result.screenshot && !supportsImages) {
			lines.push(
				"",
				"The current model does not accept images, so the screenshot was not included. Desktop control needs a vision-capable model.",
			)
		}

		const text = lines.join("\n")
		if (result.screenshot && supportsImages) {
			return [
				...formatResponse.imageBlocks([result.screenshot]),
				{ type: "text", text } as Anthropic.TextBlockParam,
			]
		}
		return text
	}

	override async handlePartial(task: Task, block: ToolUse<"computer_action">): Promise<void> {
		const action = block.params.action
		if (!action || !isComputerAction(action)) {
			return
		}
		const payload: ClineSayComputerAction = {
			action,
			coordinate: block.params.coordinate,
			text: block.params.text,
			key: block.params.key,
		}
		await task.ask("computer_action", JSON.stringify(payload), block.partial).catch(() => {})
	}
}

export const computerActionTool = new ComputerActionTool()
