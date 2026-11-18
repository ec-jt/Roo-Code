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
] as const

export type ComputerAction = (typeof computerActions)[number]

/** Actions that do not change desktop state. */
export const readOnlyComputerActions = [
	"screenshot",
	"list_windows",
	"wait",
] as const satisfies readonly ComputerAction[]

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
	/** Window title substring or window id for `focus_window`. */
	window?: string
	/** Milliseconds for `wait`. */
	duration?: string
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
	/** Coordinate after mapping to logical screen points. */
	executedCoordinate?: string
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
	error?: string
}
