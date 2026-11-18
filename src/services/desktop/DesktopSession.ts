import {
	isComputerAction,
	scrollDirections,
	type ComputerActionParams,
	type ComputerActionResult,
	type ComputerWindowInfo,
	type ScrollDirection,
} from "@roo-code/types"

import type { DesktopDriver, Point } from "./DesktopDriver"
import { computeTargetSize, downscaleToRgb, encodePngRgb } from "./image"
import { parseKeyCombo } from "./keys"
import type { UserActivityMonitor } from "./userActivity"
import type { BackgroundControl, FastScreenCapture } from "./macBackground"

/** Text longer than this is pasted from the clipboard instead of typed key by key. */
export const PASTE_THRESHOLD = 40

/** Clipboard access for paste-based typing. The previous content is restored afterwards. */
export interface ClipboardAccess {
	read(): Promise<string>
	write(text: string): Promise<void>
}

/**
 * Stateful wrapper around a DesktopDriver. Owns screenshot geometry so the model
 * can work in screenshot space while input goes to logical screen points.
 *
 * Three coordinate spaces:
 * - screenshot: the downscaled PNG the model sees (for example 1280x831)
 * - capture:    raw capture pixels (for example 3024x1964 on a 2x Retina display)
 * - screen:     logical points used by mouse input (for example 1512x982)
 * Mapping is screenshot -> screen directly: x * screen.width / shot.width.
 */

export const DEFAULT_MAX_WIDTH = 1280
export const DEFAULT_MAX_HEIGHT = 800
export const DEFAULT_SETTLE_MS = 200
/** Fixed gap between the steps of a batch, so the target app can take the input. No screen settle wait. */
export const BATCH_STEP_GAP_MS = 50
export const DEFAULT_SCROLL_AMOUNT = 3
export const MAX_SCROLL_AMOUNT = 50
export const MAX_WAIT_MS = 10_000
export const MAX_TYPE_LENGTH = 10_000

/** Actions that use the shared mouse and keyboard, so they take turns with the user. */
const SHARED_INPUT_ACTIONS: ReadonlySet<string> = new Set([
	"move",
	"click",
	"double_click",
	"right_click",
	"drag",
	"type",
	"key",
	"scroll",
	"focus_window",
])

/** Pointer actions after which the user's cursor is put back where it was. "move" is excluded: its purpose is to leave the cursor there. */
const RESTORE_CURSOR_ACTIONS: ReadonlySet<string> = new Set(["click", "double_click", "right_click", "drag", "scroll"])

export class ComputerActionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "ComputerActionError"
	}
}

interface Geometry {
	shotWidth: number
	shotHeight: number
	screenWidth: number
	screenHeight: number
}

export interface DesktopSessionOptions {
	maxWidth?: number
	maxHeight?: number
	/** Delay after state-changing actions before the follow-up screenshot. */
	settleMs?: number
	platform?: string
	sleep?: (ms: number) => Promise<void>
	/** Detects user input so shared-input actions wait for the user to stop. */
	activity?: UserActivityMonitor
	/** Per-window control that does not use the shared cursor (macOS). */
	background?: BackgroundControl
	/** Faster full-screen capture that returns a scaled JPEG (macOS). Falls back to libnut + PNG on error. */
	fastCapture?: FastScreenCapture
	/** Clipboard for pasting long text. Without it, all text is typed key by key. */
	clipboard?: ClipboardAccess
}

export interface ExecuteOptions {
	/** false: skip the settle wait and the screenshot after a state-changing action. */
	screenshot?: boolean
}

export interface BatchStepResult {
	params: ComputerActionParams
	/** First coordinate of the step in logical screen points, "x,y". */
	executedCoordinate?: string
}

export interface BatchOptions extends ExecuteOptions {
	/** Called before each step, after the previous one finished. Return true to stop the batch. */
	shouldAbort?: () => boolean
	/** Called before each step. Throw a ComputerActionError to stop the batch at that step. */
	beforeStep?: (step: ComputerActionParams, index: number) => void | Promise<void>
}

export interface BatchResult extends ComputerActionResult {
	/** Steps that finished, in order. */
	completed: BatchStepResult[]
	/** Set when a step failed: its 0-based index and the error message. */
	failed?: { index: number; message: string }
	/** Index of the next step when the task was aborted between steps. */
	abortedAt?: number
}

export interface ScreenshotResult {
	dataUrl: string
	width: number
	height: number
	cursor?: Point
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class DesktopSession {
	private geometry: Geometry | undefined
	private readonly maxWidth: number
	private readonly maxHeight: number
	private readonly settleMs: number
	private readonly platform: string
	private readonly sleep: (ms: number) => Promise<void>
	private readonly activity: UserActivityMonitor | undefined
	private readonly background: BackgroundControl | undefined
	private readonly fastCapture: FastScreenCapture | undefined
	private readonly clipboard: ClipboardAccess | undefined

	constructor(
		private readonly driver: DesktopDriver,
		options: DesktopSessionOptions = {},
	) {
		this.maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH
		this.maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT
		this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
		this.platform = options.platform ?? process.platform
		this.sleep = options.sleep ?? defaultSleep
		this.activity = options.activity
		this.background = options.background
		this.fastCapture = options.fastCapture
		this.clipboard = options.clipboard
	}

	/**
	 * Screenshot for results. Uses the fast system capture when available
	 * (JPEG, about 0.3 s) and falls back to the libnut capture (PNG).
	 */
	async captureScreenshot(): Promise<ScreenshotResult> {
		if (this.fastCapture) {
			try {
				const screen = this.driver.getScreenSize()
				// Size from logical points: never larger than the screen in points, never above the max.
				const target = computeTargetSize(screen.width, screen.height, this.maxWidth, this.maxHeight)
				const shot = await this.fastCapture(target.width, target.height)
				this.geometry = {
					shotWidth: shot.width,
					shotHeight: shot.height,
					screenWidth: screen.width,
					screenHeight: screen.height,
				}
				let cursor: Point | undefined
				try {
					cursor = this.toScreenshotPoint(this.driver.getMousePosition())
				} catch {
					cursor = undefined
				}
				return { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, cursor }
			} catch {
				// Fall through to the libnut capture.
			}
		}
		return this.screenshot()
	}

	/** True when per-window background actions are available on this platform. */
	get supportsBackground(): boolean {
		return this.background !== undefined
	}

	/** Capture the primary display, downscale, and encode as PNG. Updates the coordinate mapping. */
	screenshot(): ScreenshotResult {
		const screen = this.driver.getScreenSize()
		const capture = this.driver.captureScreen()

		if (capture.width <= 0 || capture.height <= 0 || capture.image.length === 0) {
			throw new ComputerActionError(
				"The screenshot is empty. On macOS this usually means Screen Recording permission is missing for Visual Studio Code.",
			)
		}

		const target = computeTargetSize(capture.width, capture.height, this.maxWidth, this.maxHeight)
		const rgb = downscaleToRgb(capture, target.width, target.height)
		const png = encodePngRgb(rgb, target.width, target.height)

		this.geometry = {
			shotWidth: target.width,
			shotHeight: target.height,
			screenWidth: screen.width,
			screenHeight: screen.height,
		}

		let cursor: Point | undefined
		try {
			cursor = this.toScreenshotPoint(this.driver.getMousePosition())
		} catch {
			cursor = undefined
		}

		return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, ...target, cursor }
	}

	/** Parse "x,y" in screenshot space and map it to logical screen points. */
	toScreenPoint(coordinate: string | undefined, paramName = "coordinate"): Point {
		if (!coordinate) {
			throw new ComputerActionError(`Missing "${paramName}". Provide "x,y" in screenshot pixels.`)
		}

		const match = /^\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?\s*$/.exec(coordinate)
		if (!match) {
			throw new ComputerActionError(`Invalid ${paramName} "${coordinate}". Use "x,y", for example "640,400".`)
		}

		const geometry = this.requireGeometry()
		const x = Number(match[1])
		const y = Number(match[2])

		if (x < 0 || y < 0 || x >= geometry.shotWidth || y >= geometry.shotHeight) {
			throw new ComputerActionError(
				`${paramName} ${x},${y} is outside the screenshot (${geometry.shotWidth}x${geometry.shotHeight}).`,
			)
		}

		return {
			x: Math.min(geometry.screenWidth - 1, Math.round((x * geometry.screenWidth) / geometry.shotWidth)),
			y: Math.min(geometry.screenHeight - 1, Math.round((y * geometry.screenHeight) / geometry.shotHeight)),
		}
	}

	/** Map a logical screen point back to screenshot space. */
	toScreenshotPoint(point: Point): Point {
		const geometry = this.requireGeometry()
		return {
			x: Math.round((point.x * geometry.shotWidth) / geometry.screenWidth),
			y: Math.round((point.y * geometry.shotHeight) / geometry.screenHeight),
		}
	}

	getActiveWindowTitle(): string | undefined {
		try {
			const handle = this.driver.getActiveWindowHandle()
			return this.driver.listWindows().find((w) => w.handle === handle)?.title
		} catch {
			return undefined
		}
	}

	listWindows(): ComputerWindowInfo[] {
		let active: number | undefined
		try {
			active = this.driver.getActiveWindowHandle()
		} catch {
			active = undefined
		}
		return this.driver.listWindows().map((w) => ({
			id: w.handle,
			title: w.title,
			x: w.rect.x,
			y: w.rect.y,
			width: w.rect.width,
			height: w.rect.height,
			active: w.handle === active,
		}))
	}

	/**
	 * Run one action. State-changing actions are followed by a settle delay and a
	 * fresh screenshot so the model always sees the result, unless
	 * `options.screenshot` is false.
	 * Approval and the app allowlist are enforced by the caller before this runs.
	 */
	async execute(
		params: ComputerActionParams,
		options: ExecuteOptions = {},
	): Promise<ComputerActionResult & { executedCoordinate?: string }> {
		if (!isComputerAction(params.action)) {
			throw new ComputerActionError(`Unknown action "${String(params.action)}".`)
		}

		switch (params.action) {
			case "screenshot":
				return this.result()

			case "list_elements": {
				const background = this.requireBackground()
				const target = this.findWindow(params.window)
				let elements
				try {
					elements = await background.listElements(target.id)
				} catch (error) {
					throw new ComputerActionError(
						`Could not read the elements of "${target.title}": ${error instanceof Error ? error.message : String(error)}`,
					)
				}
				this.requireGeometry()
				return {
					windowTitle: target.title,
					activeWindowTitle: this.getActiveWindowTitle(),
					elements: elements.map((e) => ({
						role: e.role,
						name: e.name,
						center:
							e.x !== undefined && e.y !== undefined
								? (() => {
										const p = this.toScreenshotPoint({ x: e.x, y: e.y })
										return `${p.x},${p.y}`
									})()
								: undefined,
					})),
				}
			}

			case "window_screenshot": {
				const target = this.findWindow(params.window)
				return this.windowResult(target)
			}

			case "list_windows":
				return { windows: this.listWindows(), activeWindowTitle: this.getActiveWindowTitle() }

			case "wait": {
				await this.sleep(parseBoundedInt(params.duration, "duration", 1000, 0, MAX_WAIT_MS))
				return this.result()
			}
		}

		const step = await this.runStep(params)
		if (options.screenshot === false) {
			return {
				executedCoordinate: step.executedCoordinate,
				windowTitle: step.window?.title,
				activeWindowTitle: this.getActiveWindowTitle(),
			}
		}
		await this.sleep(this.settleMs)
		if (step.window) {
			return this.windowResult(step.window)
		}
		return { ...(await this.result()), executedCoordinate: step.executedCoordinate }
	}

	/**
	 * Run several state-changing steps in order with one settle wait and one
	 * screenshot at the end. Each step still takes turns with the user. The batch
	 * stops at the first failing step or when `shouldAbort` returns true; the
	 * result then names the step and lists the steps that finished.
	 * Approval and validation are done by the caller before this runs.
	 */
	async executeBatch(steps: ComputerActionParams[], options: BatchOptions = {}): Promise<BatchResult> {
		const completed: BatchStepResult[] = []
		let lastWindow: ComputerWindowInfo | undefined

		for (let index = 0; index < steps.length; index++) {
			if (options.shouldAbort?.()) {
				return { completed, abortedAt: index }
			}
			const params = steps[index]
			try {
				if (!isComputerAction(params.action)) {
					throw new ComputerActionError(`Unknown action "${String(params.action)}".`)
				}
				await options.beforeStep?.(params, index)
				let executedCoordinate: string | undefined
				if (params.action === "wait") {
					await this.sleep(parseBoundedInt(params.duration, "duration", 1000, 0, MAX_WAIT_MS))
				} else {
					const step = await this.runStep(params)
					executedCoordinate = step.executedCoordinate
					lastWindow = step.window
				}
				completed.push({ params, executedCoordinate })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				let shot: ComputerActionResult = {}
				try {
					shot = lastWindow ? await this.windowResult(lastWindow) : await this.result()
				} catch {
					shot = {}
				}
				return { ...shot, completed, failed: { index, message } }
			}
			if (index < steps.length - 1 && BATCH_STEP_GAP_MS > 0) {
				await this.sleep(BATCH_STEP_GAP_MS)
			}
		}

		if (options.screenshot === false) {
			return {
				completed,
				windowTitle: lastWindow?.title,
				activeWindowTitle: this.getActiveWindowTitle(),
			}
		}
		await this.sleep(this.settleMs)
		const shot = lastWindow ? await this.windowResult(lastWindow) : await this.result()
		return { ...shot, completed }
	}

	/**
	 * Perform one state-changing action without the settle wait or screenshot.
	 * Returns the executed coordinate, and the window for background actions.
	 */
	private async runStep(
		params: ComputerActionParams,
	): Promise<{ executedCoordinate?: string; window?: ComputerWindowInfo }> {
		let executedCoordinate: string | undefined
		const point = (value: string | undefined, name?: string) => {
			const p = this.toScreenPoint(value, name)
			executedCoordinate ??= `${p.x},${p.y}`
			return p
		}

		// Take turns with the user for actions that use the shared mouse and keyboard.
		const sharedInput = SHARED_INPUT_ACTIONS.has(params.action)
		let userCursor: Point | undefined
		if (sharedInput) {
			await this.takeTurn()
			if (RESTORE_CURSOR_ACTIONS.has(params.action)) {
				userCursor = this.safeCursor()
			}
		}

		switch (params.action) {
			case "click_element": {
				if (!params.element?.trim()) {
					throw new ComputerActionError('Missing "element". Use a name from list_elements.')
				}
				const background = this.requireBackground()
				const target = this.findWindow(params.window)
				try {
					await background.pressElement(target.id, params.element)
				} catch (error) {
					throw new ComputerActionError(
						`Could not click "${params.element}" in "${target.title}": ${error instanceof Error ? error.message : String(error)}. ` +
							"Use list_elements to see the element names, or click by coordinate.",
					)
				}
				return { window: target }
			}

			case "window_type": {
				if (isTrue(params.submit)) {
					throw new ComputerActionError(
						"submit is not available for window_type: background typing cannot press Enter. Use click_element on the send button, or type with submit when the user is idle.",
					)
				}
				if (!params.text) {
					throw new ComputerActionError('Missing "text" for window_type.')
				}
				if (params.text.length > MAX_TYPE_LENGTH) {
					throw new ComputerActionError(
						`text is too long (${params.text.length} > ${MAX_TYPE_LENGTH} characters).`,
					)
				}
				const background = this.requireBackground()
				const target = this.findWindow(params.window)
				try {
					await background.typeInWindow(target.id, params.text)
				} catch (error) {
					throw new ComputerActionError(
						`Could not type into "${target.title}" in the background: ${error instanceof Error ? error.message : String(error)}. ` +
							"Click the text field once with the normal actions (when the user is idle), then try again.",
					)
				}
				return { window: target }
			}

			case "move":
				this.driver.moveMouse(point(params.coordinate))
				break

			case "click":
			case "double_click":
			case "right_click": {
				this.driver.moveMouse(point(params.coordinate))
				this.driver.click(params.action === "right_click" ? "right" : "left", params.action === "double_click")
				break
			}

			case "drag": {
				const from = point(params.coordinate)
				const to = this.toScreenPoint(params.end_coordinate, "end_coordinate")
				this.driver.drag(from, to)
				break
			}

			case "type": {
				if (!params.text) {
					throw new ComputerActionError('Missing "text" for type.')
				}
				if (params.text.length > MAX_TYPE_LENGTH) {
					throw new ComputerActionError(
						`text is too long (${params.text.length} > ${MAX_TYPE_LENGTH} characters).`,
					)
				}
				await this.typeText(params.text)
				if (isTrue(params.submit)) {
					const enter = parseKeyCombo("enter", this.platform)
					this.driver.keyTap(enter.key, enter.modifiers)
				}
				break
			}

			case "key": {
				if (!params.key) {
					throw new ComputerActionError('Missing "key", for example "enter" or "cmd+c".')
				}
				let combo
				try {
					combo = parseKeyCombo(params.key, this.platform)
				} catch (error) {
					throw new ComputerActionError(error instanceof Error ? error.message : String(error))
				}
				this.driver.keyTap(combo.key, combo.modifiers)
				break
			}

			case "scroll": {
				const direction = params.direction ?? "down"
				if (!(scrollDirections as readonly string[]).includes(direction)) {
					throw new ComputerActionError(`Invalid direction "${direction}". Use up, down, left, or right.`)
				}
				const amount = parseBoundedInt(params.amount, "amount", DEFAULT_SCROLL_AMOUNT, 1, MAX_SCROLL_AMOUNT)
				if (params.coordinate) {
					this.driver.moveMouse(point(params.coordinate))
				}
				const [dx, dy] = scrollVector(direction as ScrollDirection, amount)
				this.driver.scroll(dx, dy)
				break
			}

			case "focus_window": {
				const target = this.findWindow(params.window)
				this.driver.focusWindow(target.id)
				break
			}

			default:
				throw new ComputerActionError(`"${params.action}" cannot run as an input step.`)
		}

		if (sharedInput) {
			// Put the user's cursor back right away, so it is displaced only for the action itself.
			if (userCursor) {
				try {
					this.driver.moveMouse(userCursor)
				} catch {
					// Not critical: the action already ran.
				}
			}
			this.activity?.noteInjected(this.safeCursor())
		}

		return { executedCoordinate }
	}

	/**
	 * Type text. Long text is pasted from the clipboard (faster, and autocorrect
	 * does not change it); the user's clipboard is restored afterwards.
	 */
	private async typeText(text: string): Promise<void> {
		if (!this.clipboard || text.length <= PASTE_THRESHOLD) {
			this.driver.typeText(text)
			return
		}
		let previous: string | undefined
		try {
			previous = await this.clipboard.read()
		} catch {
			previous = undefined
		}
		try {
			await this.clipboard.write(text)
			const combo = parseKeyCombo("cmd+v", this.platform)
			this.driver.keyTap(combo.key, combo.modifiers)
			// Give the app time to read the clipboard before it is restored.
			await this.sleep(250)
		} catch {
			this.driver.typeText(text)
			return
		} finally {
			if (previous !== undefined) {
				await this.clipboard.write(previous).catch(() => {})
			}
		}
	}

	/** Wait until the user stops using the mouse and keyboard, or fail with guidance. */
	private async takeTurn(): Promise<void> {
		if (!this.activity) {
			return
		}
		const { idle, waitedMs } = await this.activity.waitForIdle()
		if (idle) {
			return
		}
		const seconds = Math.round(waitedMs / 1000)
		throw new ComputerActionError(
			`The user is using the mouse or keyboard, so the action did not run (waited ${seconds} s). ` +
				(this.background
					? "To keep working without taking over the cursor, use window_screenshot and window_type on a specific window. Otherwise use wait and try again."
					: "Use wait and try again, or ask the user to pause."),
		)
	}

	private requireBackground(): BackgroundControl {
		if (!this.background) {
			throw new ComputerActionError(
				"Background window actions (window_screenshot, window_type) are only available on macOS.",
			)
		}
		return this.background
	}

	private async windowResult(target: ComputerWindowInfo): Promise<ComputerActionResult> {
		const background = this.requireBackground()
		let capture
		try {
			capture = await background.captureWindow(target.id, Math.max(this.maxWidth, this.maxHeight))
		} catch (error) {
			throw new ComputerActionError(
				`Could not capture the window "${target.title}": ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return {
			screenshot: capture.dataUrl,
			screenshotWidth: capture.width,
			screenshotHeight: capture.height,
			windowTitle: target.title,
			activeWindowTitle: this.getActiveWindowTitle(),
		}
	}

	private safeCursor(): Point | undefined {
		try {
			return this.driver.getMousePosition()
		} catch {
			return undefined
		}
	}

	/** Resolve a window by id or title. Public so callers can check the allowlist before focusing. */
	findWindow(query: string | undefined): ComputerWindowInfo {
		if (!query?.trim()) {
			throw new ComputerActionError('Missing "window". Give a window id or part of its title (see list_windows).')
		}

		const windows = this.listWindows()
		const trimmed = query.trim()

		if (/^\d+$/.test(trimmed)) {
			const byId = windows.find((w) => w.id === Number(trimmed))
			if (byId) return byId
		}

		const needle = trimmed.toLowerCase()
		const exact = windows.find((w) => w.title.toLowerCase() === needle)
		if (exact) return exact

		const partial = windows.filter((w) => w.title.toLowerCase().includes(needle))
		if (partial.length === 1) return partial[0]

		if (partial.length > 1) {
			throw new ComputerActionError(
				`"${query}" matches ${partial.length} windows: ${partial
					.slice(0, 10)
					.map((w) => `${w.id} "${w.title}"`)
					.join(", ")}. Use the window id.`,
			)
		}

		throw new ComputerActionError(`No window matches "${query}". Use list_windows to see open windows.`)
	}

	private async result(): Promise<ComputerActionResult> {
		const shot = await this.captureScreenshot()
		return {
			screenshot: shot.dataUrl,
			screenshotWidth: shot.width,
			screenshotHeight: shot.height,
			cursorPosition: shot.cursor ? `${shot.cursor.x},${shot.cursor.y}` : undefined,
			activeWindowTitle: this.getActiveWindowTitle(),
		}
	}

	private requireGeometry(): Geometry {
		if (!this.geometry) {
			// Establish the mapping from the current screen so a first action without a screenshot still works.
			this.screenshot()
		}
		return this.geometry!
	}
}

/** Case-insensitive substring match against the allowlist. An empty allowlist allows everything. */
export function isWindowAllowed(title: string | undefined, allowlist: readonly string[] | undefined): boolean {
	const entries = (allowlist ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)
	if (entries.length === 0) {
		return true
	}
	if (!title) {
		return false
	}
	const lower = title.toLowerCase()
	return entries.some((entry) => lower.includes(entry))
}

function scrollVector(direction: ScrollDirection, amount: number): [number, number] {
	switch (direction) {
		case "up":
			return [0, -amount]
		case "down":
			return [0, amount]
		case "left":
			return [-amount, 0]
		case "right":
			return [amount, 0]
	}
}

/** Accept true and "true": tool arguments may arrive as strings. */
export function isTrue(value: unknown): boolean {
	return value === true || value === "true"
}

function parseBoundedInt(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
	if (value === undefined || value === "") {
		return fallback
	}
	const n = Number(value)
	if (!Number.isFinite(n)) {
		throw new ComputerActionError(`Invalid ${name} "${value}". Use a number between ${min} and ${max}.`)
	}
	return Math.min(max, Math.max(min, Math.round(n)))
}
