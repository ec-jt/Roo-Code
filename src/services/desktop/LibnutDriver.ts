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
 * DesktopDriver backed by the raw libnut N-API module.
 *
 * Scroll direction note: libnut follows robotjs, where scrollMouse(x, y) with
 * positive y scrolls up on some platforms. The sign convention here is
 * "positive dy scrolls content down" and is applied in one place
 * (SCROLL_Y_SIGN) so it can be corrected after manual verification on each OS.
 */
export const SCROLL_Y_SIGN = -1
export const SCROLL_X_SIGN = 1

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
		this.native.moveMouse(Math.round(point.x), Math.round(point.y))
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
			this.native.keyTap(key, modifiers)
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
