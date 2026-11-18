import * as path from "path"

/**
 * The subset of the raw libnut N-API exports used by LibnutDriver.
 * These are the exports of `libnut.node` itself, not the `@nut-tree-fork/libnut`
 * JavaScript wrapper (which renames captureScreen to screen.capture and needs `bindings`).
 */
export interface LibnutNative {
	getScreenSize(): { width: number; height: number }
	captureScreen(
		x?: number,
		y?: number,
		width?: number,
		height?: number,
	): {
		width: number
		height: number
		byteWidth: number
		bitsPerPixel: number
		bytesPerPixel: number
		image: Buffer
	}
	getMousePos(): { x: number; y: number }
	moveMouse(x: number, y: number): void
	mouseClick(button?: string, double?: boolean): void
	mouseToggle(down?: string, button?: string): void
	dragMouse(x: number, y: number): void
	scrollMouse(x: number, y: number): void
	keyTap(key: string, modifier?: string | string[]): void
	typeString(text: string): void
	setMouseDelay(ms: number): void
	setKeyboardDelay(ms: number): void
	getWindows(): number[]
	getActiveWindow(): number
	getWindowTitle(handle: number): string
	getWindowRect(handle: number): { x: number; y: number; width: number; height: number }
	focusWindow(handle: number): void
}

/** Platform and architecture pairs that have a bundled libnut 2.7.5 prebuild. */
const SUPPORTED: Record<string, readonly string[]> = {
	darwin: ["x64", "arm64"], // one universal Mach-O binary
	win32: ["x64"],
	linux: ["x64"],
}

export class DesktopUnsupportedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "DesktopUnsupportedError"
	}
}

export function isPlatformSupported(platform: string = process.platform, arch: string = process.arch): boolean {
	return SUPPORTED[platform]?.includes(arch) ?? false
}

/** Absolute path of the bundled binary: <extensionPath>/dist/native/libnut/<platform>/libnut.node */
export function resolveLibnutPath(extensionPath: string, platform: string = process.platform): string {
	return path.join(extensionPath, "dist", "native", "libnut", platform, "libnut.node")
}

export type NativeRequire = (id: string) => unknown

const REQUIRED_EXPORTS: (keyof LibnutNative)[] = [
	"getScreenSize",
	"captureScreen",
	"getMousePos",
	"moveMouse",
	"mouseClick",
	"mouseToggle",
	"dragMouse",
	"scrollMouse",
	"keyTap",
	"typeString",
	"getWindows",
	"getActiveWindow",
	"getWindowTitle",
	"getWindowRect",
	"focusWindow",
]

let cached: { key: string; native: LibnutNative } | undefined

/**
 * Load libnut from an explicit path. Called lazily on first use, never at activation,
 * so a missing or incompatible binary cannot break the extension.
 *
 * @param nativeRequire injectable for tests; defaults to Node's require.
 */
export function loadLibnut(
	extensionPath: string,
	options: { platform?: string; arch?: string; nativeRequire?: NativeRequire } = {},
): LibnutNative {
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch

	if (!isPlatformSupported(platform, arch)) {
		throw new DesktopUnsupportedError(
			`Desktop control is not available on ${platform}-${arch}. Supported: macOS (Intel and Apple Silicon), Windows x64, Linux x64.`,
		)
	}

	const binaryPath = resolveLibnutPath(extensionPath, platform)

	if (cached && cached.key === binaryPath && !options.nativeRequire) {
		return cached.native
	}

	const nativeRequire: NativeRequire = options.nativeRequire ?? require

	let native: unknown
	try {
		native = nativeRequire(binaryPath)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new DesktopUnsupportedError(`Failed to load the desktop control library from ${binaryPath}: ${reason}`)
	}

	const missing = REQUIRED_EXPORTS.filter(
		(name) => typeof (native as Record<string, unknown> | null)?.[name] !== "function",
	)
	if (missing.length > 0) {
		throw new DesktopUnsupportedError(
			`The desktop control library at ${binaryPath} is missing expected functions: ${missing.join(", ")}`,
		)
	}

	if (!options.nativeRequire) {
		cached = { key: binaryPath, native: native as LibnutNative }
	}

	return native as LibnutNative
}

/** Test helper. */
export function resetLibnutCache(): void {
	cached = undefined
}
