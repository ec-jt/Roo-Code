import type {
	DesktopDriver,
	DesktopWindow,
	KeyModifier,
	MouseButton,
	Point,
	RawCapture,
	ScreenSize,
} from "./DesktopDriver"
import type { LibnutNative } from "./libnutLoader"

/** Default delays. libnut defaults are 10 ms (mouse) and 10 ms (keyboard). */
const MOUSE_DELAY_MS = 10
const KEYBOARD_DELAY_MS = 10

/**
 * Maximum time to wait for the cursor to reach a move target.
 * On macOS the first move in a process can take about 35 ms to apply. libnut
 * clicks at the current cursor position, so clicking before the move has
 * applied would hit the old position.
 */
export const MOVE_SETTLE_TIMEOUT_MS = 150
const MOVE_POLL_MS = 2

function blockingSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * DesktopDriver backed by the raw libnut N-API module.
 *
 * Scroll direction note: libnut follows robotjs, where scrollMouse(x, y) with
 * positive y scrolls up on some platforms. The sign convention here is
 * "positive dy scrolls content down" and is applied in one place
 * (SCROLL_Y_SIGN) so it can be corrected after manual verification on each OS.
 */
export const SCROLL_Y_SIGN = -1
export const SCROLL_X_SIGN = 1

/**
 * libnut modifier flag names. libnut rejects "command" with
 * "Invalid key flag specified"; the Command / Windows key is "meta".
 */
export function toLibnutModifier(modifier: KeyModifier): string {
	return modifier === "command" ? "meta" : modifier
}

export class LibnutDriver implements DesktopDriver {
	constructor(private readonly native: LibnutNative) {
		native.setMouseDelay?.(MOUSE_DELAY_MS)
		native.setKeyboardDelay?.(KEYBOARD_DELAY_MS)
	}

	getScreenSize(): ScreenSize {
		const { width, height } = this.native.getScreenSize()
		return { width, height }
	}

	captureScreen(): RawCapture {
		const capture = this.native.captureScreen()
		return {
			width: capture.width,
			height: capture.height,
			byteWidth: capture.byteWidth,
			bytesPerPixel: capture.bytesPerPixel,
			image: capture.image,
		}
	}

	getMousePosition(): Point {
		const { x, y } = this.native.getMousePos()
		return { x, y }
	}

	moveMouse(point: Point): void {
		const x = Math.round(point.x)
		const y = Math.round(point.y)
		this.native.moveMouse(x, y)
		this.waitForCursor(x, y)
	}

	/** Wait until the cursor reports the target position, or the timeout passes. */
	private waitForCursor(x: number, y: number): void {
		const deadline = Date.now() + MOVE_SETTLE_TIMEOUT_MS
		for (;;) {
			let pos: { x: number; y: number }
			try {
				pos = this.native.getMousePos()
			} catch {
				return
			}
			// Allow 1 point of rounding difference on scaled displays.
			if (Math.abs(pos.x - x) <= 1 && Math.abs(pos.y - y) <= 1) {
				return
			}
			if (Date.now() >= deadline) {
				return
			}
			blockingSleep(MOVE_POLL_MS)
		}
	}

	click(button: MouseButton, double: boolean): void {
		this.native.mouseClick(button, double)
	}

	drag(from: Point, to: Point): void {
		this.moveMouse(from)
		this.native.mouseToggle("down", "left")
		try {
			this.native.dragMouse(Math.round(to.x), Math.round(to.y))
		} finally {
			// Always release the button, even if the drag fails.
			this.native.mouseToggle("up", "left")
		}
	}

	scroll(dx: number, dy: number): void {
		this.native.scrollMouse(Math.round(dx) * SCROLL_X_SIGN, Math.round(dy) * SCROLL_Y_SIGN)
	}

	keyTap(key: string, modifiers: KeyModifier[]): void {
		if (modifiers.length > 0) {
			this.native.keyTap(key, modifiers.map(toLibnutModifier))
		} else {
			this.native.keyTap(key)
		}
	}

	typeText(text: string): void {
		this.native.typeString(text)
	}

	listWindows(): DesktopWindow[] {
		const windows: DesktopWindow[] = []
		for (const handle of this.native.getWindows()) {
			try {
				const title = this.native.getWindowTitle(handle)
				const rect = this.native.getWindowRect(handle)
				// Skip windows without a title or with no area (menu bar items, hidden helpers).
				if (!title || rect.width <= 0 || rect.height <= 0) {
					continue
				}
				windows.push({ handle, title, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
			} catch {
				// A window can close between getWindows() and the per-window calls.
			}
		}
		return windows
	}

	getActiveWindowHandle(): number {
		return this.native.getActiveWindow()
	}

	focusWindow(handle: number): void {
		this.native.focusWindow(handle)
	}
}
