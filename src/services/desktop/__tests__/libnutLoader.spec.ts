import * as path from "path"

import {
	DesktopUnsupportedError,
	isPlatformSupported,
	loadLibnut,
	resetLibnutCache,
	resolveLibnutPath,
	type LibnutNative,
} from "../libnutLoader"

function fakeNative(overrides: Partial<Record<keyof LibnutNative, unknown>> = {}): Record<string, unknown> {
	const fn = () => undefined
	return {
		getScreenSize: fn,
		captureScreen: fn,
		getMousePos: fn,
		moveMouse: fn,
		mouseClick: fn,
		mouseToggle: fn,
		dragMouse: fn,
		scrollMouse: fn,
		keyTap: fn,
		typeString: fn,
		setMouseDelay: fn,
		setKeyboardDelay: fn,
		getWindows: fn,
		getActiveWindow: fn,
		getWindowTitle: fn,
		getWindowRect: fn,
		focusWindow: fn,
		...overrides,
	}
}

describe("libnutLoader", () => {
	beforeEach(() => resetLibnutCache())

	describe("isPlatformSupported", () => {
		it.each([
			["darwin", "arm64", true],
			["darwin", "x64", true],
			["win32", "x64", true],
			["linux", "x64", true],
			["linux", "arm64", false],
			["win32", "arm64", false],
			["freebsd", "x64", false],
		])("%s-%s -> %s", (platform, arch, expected) => {
			expect(isPlatformSupported(platform, arch)).toBe(expected)
		})
	})

	it("resolves the per-platform binary path under dist/native/libnut", () => {
		expect(resolveLibnutPath("/ext", "win32")).toBe(
			path.join("/ext", "dist", "native", "libnut", "win32", "libnut.node"),
		)
	})

	it("loads from the explicit path", () => {
		const nativeRequire = vi.fn(() => fakeNative())
		loadLibnut("/ext", { platform: "darwin", arch: "arm64", nativeRequire })
		expect(nativeRequire).toHaveBeenCalledWith(resolveLibnutPath("/ext", "darwin"))
	})

	it("rejects unsupported platforms before touching the filesystem", () => {
		const nativeRequire = vi.fn()
		expect(() => loadLibnut("/ext", { platform: "linux", arch: "arm64", nativeRequire })).toThrow(
			DesktopUnsupportedError,
		)
		expect(nativeRequire).not.toHaveBeenCalled()
	})

	it("wraps load failures in DesktopUnsupportedError with the path and reason", () => {
		const nativeRequire = vi.fn(() => {
			throw new Error("dlopen failed")
		})
		expect(() => loadLibnut("/ext", { platform: "linux", arch: "x64", nativeRequire })).toThrow(
			/libnut\.node: dlopen failed/,
		)
	})

	it("rejects a module that is missing required exports", () => {
		const nativeRequire = vi.fn(() => fakeNative({ captureScreen: undefined, focusWindow: 42 }))
		expect(() => loadLibnut("/ext", { platform: "win32", arch: "x64", nativeRequire })).toThrow(
			/missing expected functions: captureScreen, focusWindow/,
		)
	})
})
