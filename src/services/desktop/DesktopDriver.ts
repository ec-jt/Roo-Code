/**
 * Low-level desktop control interface.
 *
 * All coordinates are in logical screen points (the space used by mouse input).
 * Screenshot pixel dimensions may differ (for example 2x on macOS Retina).
 * Scaling between screenshot space and logical points belongs to DesktopSession,
 * not to the driver.
 */

export type MouseButton = "left" | "right" | "middle"

export type KeyModifier = "command" | "control" | "alt" | "shift"

export interface ScreenSize {
	width: number
	height: number
}

export interface Point {
	x: number
	y: number
}

export interface Rect {
	x: number
	y: number
	width: number
	height: number
}

/** Raw screen capture. `image` is BGRA, `byteWidth` bytes per row (may include padding). */
export interface RawCapture {
	width: number
	height: number
	byteWidth: number
	bytesPerPixel: number
	image: Buffer
}

export interface DesktopWindow {
	handle: number
	title: string
	rect: Rect
}

export interface DesktopDriver {
	getScreenSize(): ScreenSize
	captureScreen(): RawCapture
	getMousePosition(): Point
	moveMouse(point: Point): void
	click(button: MouseButton, double: boolean): void
	drag(from: Point, to: Point): void
	/** Positive dy scrolls content down, positive dx scrolls content right. Steps are wheel notches. */
	scroll(dx: number, dy: number): void
	/** key is a libnut key name ("a", "enter", "f5", ...). */
	keyTap(key: string, modifiers: KeyModifier[]): void
	typeText(text: string): void
	listWindows(): DesktopWindow[]
	getActiveWindowHandle(): number
	focusWindow(handle: number): void
}
