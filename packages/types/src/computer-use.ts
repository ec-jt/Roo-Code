/**
 * Computer use (desktop control) types.
 *
 * The `computer_action` tool lets the model control the user's desktop:
 * screenshots, mouse, keyboard, and window focus. Coordinates in tool
 * params are in screenshot space (the downscaled image the model sees).
 */

export const computerActions = [
	"screenshot",
	"click",
	"double_click",
	"right_click",
	"move",
	"drag",
	"type",
	"key",
	"scroll",
	"list_windows",
	"focus_window",
	"wait",
	"window_screenshot",
	"window_type",
	"list_elements",
	"click_element",
] as const

export type ComputerAction = (typeof computerActions)[number]

/** Actions that do not change desktop state. */
export const readOnlyComputerActions = [
	"screenshot",
	"list_windows",
	"wait",
	"window_screenshot",
	"list_elements",
] as const satisfies readonly ComputerAction[]

/**
 * Background actions act on one window without the shared cursor or keyboard
 * focus, so they work while the user is busy (macOS only).
 */
export const backgroundComputerActions = [
	"window_screenshot",
	"window_type",
	"list_elements",
	"click_element",
] as const satisfies readonly ComputerAction[]

/**
 * Actions allowed in background mode: they never move the pointer, press keys
 * globally, or change the front app, so the user can keep working.
 */
export const backgroundModeComputerActions = [
	"screenshot",
	"list_windows",
	"wait",
	...backgroundComputerActions,
] as const satisfies readonly ComputerAction[]

/**
 * Actions allowed as steps of a batch (`actions` parameter). Read-only actions
 * that return their own output (screenshot, list_windows, list_elements,
 * window_screenshot) are excluded: the batch returns one screenshot at the end.
 * `wait` is allowed so a batch can pause between steps.
 */
export const batchComputerActions = [
	"click",
	"double_click",
	"right_click",
	"move",
	"drag",
	"type",
	"key",
	"scroll",
	"focus_window",
	"wait",
	"window_type",
	"click_element",
] as const satisfies readonly ComputerAction[]

/** Maximum number of steps in one batched computer_action call. */
export const MAX_COMPUTER_ACTION_STEPS = 10

export function isBatchComputerAction(action: string): boolean {
	return (batchComputerActions as readonly string[]).includes(action)
}

export function isBackgroundModeAction(action: string): boolean {
	return (backgroundModeComputerActions as readonly string[]).includes(action)
}

export function isComputerAction(value: unknown): value is ComputerAction {
	return typeof value === "string" && (computerActions as readonly string[]).includes(value)
}

export const scrollDirections = ["up", "down", "left", "right"] as const

export type ScrollDirection = (typeof scrollDirections)[number]

export interface ComputerActionParams {
	action: ComputerAction
	/** "x,y" in screenshot space. */
	coordinate?: string
	/** "x,y" in screenshot space. Used by `drag`. */
	end_coordinate?: string
	/** Text for `type`. */
	text?: string
	/** Key combination for `key`, for example "cmd+c" or "ctrl+shift+t". */
	key?: string
	direction?: ScrollDirection
	/** Scroll amount in wheel steps. */
	amount?: string
	/** Window title substring or window id for `focus_window`, `window_screenshot`, and `window_type`. */
	window?: string
	/** Milliseconds for `wait`. */
	duration?: string
	/** Name of a UI element for `click_element` (from `list_elements`). */
	element?: string
	/** For `type`: press Enter after the text. */
	submit?: boolean
}

/**
 * Arguments of the `computer_action` tool call. Either `action` (one step) or
 * `actions` (a batch of 1 to MAX_COMPUTER_ACTION_STEPS steps) is given.
 */
export interface ComputerActionToolParams extends Partial<ComputerActionParams> {
	/** Steps to run in order. One approval and one final screenshot for the whole batch. */
	actions?: ComputerActionParams[]
	/** false: skip the screenshot after a state-changing action or batch. Default true. */
	screenshot?: boolean
}

/** Payload of the `computer_action` ask and say messages. */
export interface ClineSayComputerAction {
	/** Absent for a batch; see `steps`. */
	action?: ComputerAction
	/** Steps of a batched call, in order. */
	steps?: ClineSayComputerAction[]
	/** false when no screenshot is taken after the action or batch. */
	screenshot?: boolean
	/** `type`: Enter is pressed after the text. */
	submit?: boolean
	coordinate?: string
	endCoordinate?: string
	text?: string
	key?: string
	direction?: ScrollDirection
	amount?: number
	window?: string
	duration?: number
	element?: string
	/** Coordinate after mapping to logical screen points. */
	executedCoordinate?: string
}

/** A UI element from the Accessibility tree of a window (macOS). */
export interface ComputerElementInfo {
	role: string
	name: string
	/** Center of the element in screenshot pixels, "x,y", when known. */
	center?: string
}

export interface ComputerWindowInfo {
	id: number
	title: string
	x: number
	y: number
	width: number
	height: number
	active: boolean
}

export interface ComputerActionResult {
	/** data:image/png;base64,... */
	screenshot?: string
	screenshotWidth?: number
	screenshotHeight?: number
	/** Cursor position in screenshot space, "x,y". */
	cursorPosition?: string
	windows?: ComputerWindowInfo[]
	activeWindowTitle?: string
	/** Set when the screenshot shows one window (window_screenshot, window_type). */
	windowTitle?: string
	elements?: ComputerElementInfo[]
	error?: string
}
