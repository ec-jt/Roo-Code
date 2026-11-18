import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"

import {
	backgroundModeComputerActions,
	batchComputerActions,
	isBackgroundModeAction,
	isBatchComputerAction,
	isComputerAction,
	MAX_COMPUTER_ACTION_STEPS,
	readOnlyComputerActions,
	type ClineSayComputerAction,
	type ComputerAction,
	type ComputerActionParams,
	type ComputerActionResult,
	type ComputerActionToolParams,
} from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { BaseTool, ToolCallbacks } from "./BaseTool"

import { checkPlatform, formatPlatformCheckFailure } from "../../services/desktop/platformCheck"
import { getDesktopSession } from "../../services/desktop/sessionRegistry"
import {
	ComputerActionError,
	isTrue,
	isWindowAllowed,
	type BatchResult,
	type DesktopSession,
} from "../../services/desktop/DesktopSession"
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
	list_elements: ["window"],
	click_element: ["window", "element"],
}

/** Actions whose target is the window named in params.window, not the active window. */
const WINDOW_TARGETED: ReadonlySet<string> = new Set(["focus_window", "window_type", "click_element"])

/** String fields of one step. Other values are converted to strings; nulls are dropped. */
const STEP_STRING_FIELDS = [
	"action",
	"coordinate",
	"end_coordinate",
	"text",
	"key",
	"direction",
	"amount",
	"window",
	"duration",
	"element",
] as const

function isReadOnly(action: ComputerAction): boolean {
	return (readOnlyComputerActions as readonly string[]).includes(action)
}

/** Strip nulls the model may send for optional params, and keep submit as a boolean. */
function normalizeStep(raw: Record<string, unknown>): ComputerActionParams {
	const out: Record<string, unknown> = {}
	for (const key of STEP_STRING_FIELDS) {
		const value = raw?.[key]
		if (value === null || value === undefined) continue
		out[key] = typeof value === "string" ? value : String(value)
	}
	if (raw?.submit !== null && raw?.submit !== undefined) {
		out.submit = isTrue(raw.submit)
	}
	return out as unknown as ComputerActionParams
}

/** Parse `actions`: an array, or a JSON string of an array (some providers send strings). */
function parseActions(value: unknown): { steps?: unknown[]; error?: string } {
	if (value === null || value === undefined) return {}
	let parsed = value
	if (typeof value === "string") {
		if (!value.trim()) return {}
		try {
			parsed = JSON.parse(value)
		} catch {
			return { error: "actions must be a JSON array of steps." }
		}
	}
	if (!Array.isArray(parsed)) {
		return { error: "actions must be an array of steps." }
	}
	return { steps: parsed }
}

/** Parse `screenshot`: true by default; false only for false or "false". */
function parseScreenshotFlag(value: unknown): boolean {
	return !(value === false || value === "false")
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
		element: params.element,
		submit: params.submit === true ? true : undefined,
	}
}

/** One line describing a step, for the tool result. */
export function describeStep(params: ComputerActionParams, executedCoordinate?: string): string {
	const parts: string[] = [params.action]
	if (params.coordinate) parts.push(params.coordinate)
	if (params.end_coordinate) parts.push(`to ${params.end_coordinate}`)
	if (params.window) parts.push(`window "${params.window}"`)
	if (params.element) parts.push(`element "${params.element}"`)
	if (params.key) parts.push(params.key)
	if (params.direction || params.action === "scroll")
		parts.push(`${params.direction ?? "down"} ${params.amount ?? ""}`.trim())
	if (params.duration) parts.push(`${params.duration} ms`)
	if (params.text !== undefined) {
		const text = params.text.length > 60 ? `${params.text.slice(0, 60)}...` : params.text
		parts.push(JSON.stringify(text))
	}
	if (params.submit) parts.push("+ Enter")
	if (executedCoordinate) parts.push(`(screen ${executedCoordinate})`)
	return parts.join(" ")
}

type Validation = { ok: true } | { ok: false; missingParam?: keyof ComputerActionParams; message?: string }

/** Check one step's action and parameters. Does not touch the desktop. */
function validateStep(step: ComputerActionParams, inBatch: boolean): Validation {
	if (!step.action) {
		return { ok: false, missingParam: "action" }
	}
	if (!isComputerAction(step.action)) {
		return { ok: false, message: `Unknown computer_action "${step.action}".` }
	}
	if (inBatch && !isBatchComputerAction(step.action)) {
		return {
			ok: false,
			message:
				`"${step.action}" cannot be a batch step: the batch already returns one screenshot at the end. ` +
				`Allowed steps: ${batchComputerActions.join(", ")}.`,
		}
	}
	for (const name of REQUIRED_PARAMS[step.action] ?? []) {
		if (!step[name]) {
			return { ok: false, missingParam: name }
		}
	}
	if (step.submit === true) {
		if (step.action === "window_type") {
			return {
				ok: false,
				message:
					"submit is not available for window_type: background typing cannot press Enter. Use click_element on the send button instead.",
			}
		}
		if (step.action !== "type") {
			return { ok: false, message: `submit only applies to type, not "${step.action}".` }
		}
	}
	return { ok: true }
}

export class ComputerActionTool extends BaseTool<"computer_action"> {
	readonly name = "computer_action" as const

	async execute(rawParams: ComputerActionToolParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const raw = (rawParams ?? {}) as unknown as Record<string, unknown>

		const fail = async (message: string) => {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			task.didToolFailInCurrentTurn = true
			await task.say("error", message)
			pushToolResult(formatResponse.toolError(message))
		}
		const missing = async (param: string) => {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			task.didToolFailInCurrentTurn = true
			pushToolResult(await task.sayAndCreateMissingParamError(this.name, param))
		}

		// 1. Validate the call shape, every step, and its required params.
		const takeScreenshot = parseScreenshotFlag(raw.screenshot)
		const parsedActions = parseActions(raw.actions)
		if (parsedActions.error) {
			await fail(parsedActions.error)
			return
		}
		const isBatch = parsedActions.steps !== undefined
		let steps: ComputerActionParams[]

		if (isBatch) {
			if (raw.action !== null && raw.action !== undefined && raw.action !== "") {
				await fail("Give either action (one step) or actions (a batch), not both.")
				return
			}
			const rawSteps = parsedActions.steps!
			if (rawSteps.length < 1 || rawSteps.length > MAX_COMPUTER_ACTION_STEPS) {
				await fail(`actions must have 1 to ${MAX_COMPUTER_ACTION_STEPS} steps (got ${rawSteps.length}).`)
				return
			}
			steps = []
			for (let i = 0; i < rawSteps.length; i++) {
				const entry = rawSteps[i]
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					await fail(`Step ${i + 1} must be an object with an "action".`)
					return
				}
				const step = normalizeStep(entry as Record<string, unknown>)
				const check = validateStep(step, true)
				if (!check.ok) {
					await fail(
						check.missingParam
							? `Step ${i + 1} (${step.action ?? "no action"}) is missing the required parameter "${check.missingParam}".`
							: `Step ${i + 1}: ${check.message}`,
					)
					return
				}
				steps.push(step)
			}
		} else {
			const step = normalizeStep(raw)
			const check = validateStep(step, false)
			if (!check.ok) {
				if (check.missingParam) {
					await missing(check.missingParam)
				} else {
					await fail(check.message!)
				}
				return
			}
			if (!takeScreenshot && isReadOnly(step.action)) {
				await fail(
					`screenshot: false is only for actions that change something. "${step.action}" only reads, so leave screenshot out.`,
				)
				return
			}
			steps = [step]
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

		// Background mode: only actions that leave the user's pointer, keyboard, and front app alone.
		if (state.computerUseBackgroundMode === true) {
			if (process.platform !== "darwin") {
				await fail(
					"Background mode for desktop control is only available on macOS. The user can turn it off in Settings > Computer Use.",
				)
				return
			}
			for (let i = 0; i < steps.length; i++) {
				const action = steps[i].action
				if (!isBackgroundModeAction(action)) {
					await fail(
						`${isBatch ? `Step ${i + 1}: ` : ""}"${action}" is not available in background mode, because it would use the user's pointer or keyboard. ` +
							`Allowed actions: ${backgroundModeComputerActions.join(", ")}. ` +
							"Use list_elements and click_element to press buttons, and window_type to enter text. " +
							"If the task cannot be done this way, ask the user to turn off background mode in Settings > Computer Use.",
					)
					return
				}
			}
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
			//    require the target window (window-targeted actions) or the active window to match.
			//    In a batch, a focus_window step changes the window that later steps act on.
			const allowlist = state.computerUseAllowedApps ?? []
			const hasAllowlist = allowlist.some((e) => e.trim())
			if (hasAllowlist) {
				let activeTitle: string | undefined
				let activeKnown = false
				for (let i = 0; i < steps.length; i++) {
					const step = steps[i]
					if (isReadOnly(step.action)) continue
					let targetTitle: string | undefined
					if (WINDOW_TARGETED.has(step.action)) {
						targetTitle = session.findWindow(step.window).title
					} else {
						if (!activeKnown) {
							activeTitle = session.getActiveWindowTitle()
							activeKnown = true
						}
						targetTitle = activeTitle
					}
					if (!isWindowAllowed(targetTitle, allowlist)) {
						await fail(
							`${isBatch ? `Step ${i + 1}: ` : ""}The window "${targetTitle ?? "unknown"}" is not in the Computer Use app allowlist (${allowlist.join(", ")}). ` +
								"Use focus_window to switch to an allowed app, or ask the user to update the allowlist.",
						)
						return
					}
					if (step.action === "focus_window") {
						activeTitle = targetTitle
						activeKnown = true
					}
				}
			}

			if (isBatch) {
				await this.runBatch(task, callbacks, session, steps, {
					takeScreenshot,
					allowlist: hasAllowlist ? allowlist : undefined,
					warnings: check.warnings,
				})
				return
			}

			const params = steps[0]

			// 5. Approval. Auto-approval for computer_action is decided in checkAutoApproval
			//    and requires the dedicated alwaysAllowComputerUse opt-in.
			const askPayload: ClineSayComputerAction = {
				...toSayPayload(params),
				screenshot: takeScreenshot ? undefined : false,
			}
			const didApprove = await askApproval("computer_action", JSON.stringify(askPayload))
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
				result = takeScreenshot
					? await session.execute(params)
					: await session.execute(params, { screenshot: false })
			} finally {
				endActivity()
			}

			await task.say(
				"computer_action",
				JSON.stringify({ ...askPayload, executedCoordinate: result.executedCoordinate }),
				undefined,
				false,
			)
			await task.say("computer_action_result", JSON.stringify(result satisfies ComputerActionResult))

			pushToolResult(this.formatResult(params, result, task, check.warnings, takeScreenshot))
		} catch (error) {
			if (error instanceof ComputerActionError || error instanceof DesktopUnsupportedError) {
				await fail(error.message)
				return
			}
			await handleError("executing computer action", error instanceof Error ? error : new Error(String(error)))
		}
	}

	/** Approve once, run all steps, and report one result. Validation is already done. */
	private async runBatch(
		task: Task,
		callbacks: ToolCallbacks,
		session: DesktopSession,
		steps: ComputerActionParams[],
		options: { takeScreenshot: boolean; allowlist?: string[]; warnings: string[] },
	): Promise<void> {
		const { askApproval, pushToolResult } = callbacks
		const askPayload: ClineSayComputerAction = {
			steps: steps.map(toSayPayload),
			screenshot: options.takeScreenshot ? undefined : false,
		}
		const didApprove = await askApproval("computer_action", JSON.stringify(askPayload))
		if (!didApprove) {
			return
		}

		task.consecutiveMistakeCount = 0
		if (task.abort) {
			return
		}

		// Recheck the allowlist before each step: an earlier step can change the active window.
		const allowlist = options.allowlist
		const beforeStep = allowlist
			? (step: ComputerActionParams) => {
					if (isReadOnly(step.action)) return
					const title = WINDOW_TARGETED.has(step.action)
						? session.findWindow(step.window).title
						: session.getActiveWindowTitle()
					if (!isWindowAllowed(title, allowlist)) {
						throw new ComputerActionError(
							`The window "${title ?? "unknown"}" is not in the Computer Use app allowlist (${allowlist.join(", ")}).`,
						)
					}
				}
			: undefined

		const endActivity = getDesktopActivityIndicator().begin(`${steps.length} steps`)
		let result: BatchResult
		try {
			result = await session.executeBatch(steps, {
				screenshot: options.takeScreenshot,
				shouldAbort: () => task.abort === true,
				beforeStep,
			})
		} finally {
			endActivity()
		}

		// Stopped by the user (Stop button or the stop command): the task is ending.
		if (result.abortedAt !== undefined || task.abort) {
			return
		}

		const { completed, failed, abortedAt: _abortedAt, ...shot } = result
		const executed: ClineSayComputerAction = {
			steps: completed.map((s) => ({ ...toSayPayload(s.params), executedCoordinate: s.executedCoordinate })),
			screenshot: askPayload.screenshot,
		}
		await task.say("computer_action", JSON.stringify(executed), undefined, false)

		const resultForUi: ComputerActionResult = failed
			? { ...shot, error: `Step ${failed.index + 1} failed: ${failed.message}` }
			: shot
		await task.say("computer_action_result", JSON.stringify(resultForUi))

		const lines: string[] = []
		if (failed) {
			task.consecutiveMistakeCount++
			task.recordToolError(this.name)
			task.didToolFailInCurrentTurn = true
			const failedStep = steps[failed.index]
			lines.push(
				`Error: step ${failed.index + 1} of ${steps.length} (${failedStep.action}) failed: ${failed.message}`,
				`${completed.length} of ${steps.length} steps finished before it. The remaining steps did not run.`,
			)
		} else {
			lines.push(`Batch of ${steps.length} steps executed.`)
		}
		if (completed.length > 0) {
			lines.push("Steps that ran:")
			completed.forEach((s, i) => lines.push(`${i + 1}. ${describeStep(s.params, s.executedCoordinate)}`))
		}

		pushToolResult(this.formatShot(lines, shot, task, options.warnings, options.takeScreenshot || !!failed))
	}

	private formatResult(
		params: ComputerActionParams,
		result: ComputerActionResult & { executedCoordinate?: string },
		task: Task,
		warnings: string[],
		takeScreenshot = true,
	) {
		const lines: string[] = []

		if (params.action === "list_elements") {
			const elements = result.elements ?? []
			lines.push(`Elements in "${result.windowTitle ?? params.window}" (${elements.length}):`)
			for (const e of elements) {
				lines.push(`- ${e.role} "${e.name || "(no name)"}"${e.center ? ` at ${e.center}` : ""}`)
			}
			lines.push(
				"",
				"Use click_element with the window and the element name to press one without moving the pointer. Positions are in pixels of the latest full screenshot.",
			)
		} else if (params.action === "list_windows") {
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
			return this.formatShot(lines, result, task, warnings, takeScreenshot)
		}

		for (const warning of warnings) lines.push(`Note: ${warning}`)
		return lines.join("\n")
	}

	/** Add screenshot details to the text and return text, or image blocks followed by text. */
	private formatShot(
		lines: string[],
		result: ComputerActionResult,
		task: Task,
		warnings: string[],
		screenshotRequested: boolean,
	) {
		if (!result.screenshot && !screenshotRequested) {
			lines.push("No screenshot was taken (screenshot: false). Take one when you need to see the result.")
		} else if (result.windowTitle && result.screenshot) {
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
		if (action && isComputerAction(action)) {
			const payload: ClineSayComputerAction = {
				action,
				coordinate: block.params.coordinate,
				text: block.params.text,
				key: block.params.key,
			}
			await task.ask("computer_action", JSON.stringify(payload), block.partial).catch(() => {})
			return
		}
		// Batch: show the steps once the array parses; partial JSON is skipped.
		const rawActions = block.params.actions
		if (!rawActions) {
			return
		}
		const parsed = parseActions(rawActions)
		if (!parsed.steps) {
			return
		}
		const steps = parsed.steps
			.filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
			.map((s) => normalizeStep(s))
			.filter((s) => isComputerAction(s.action))
			.map(toSayPayload)
		if (steps.length === 0) {
			return
		}
		await task.ask("computer_action", JSON.stringify({ steps }), block.partial).catch(() => {})
	}
}

export const computerActionTool = new ComputerActionTool()
