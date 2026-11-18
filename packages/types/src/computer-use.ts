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
}

/** Payload of the `computer_action` ask and say messages. */
export interface ClineSayComputerAction {
	action: ComputerAction
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
