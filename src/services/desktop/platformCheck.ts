import * as path from "path"

import { isPlatformSupported, type NativeRequire } from "./libnutLoader"

/**
 * Pre-flight checks for desktop control. Pure apart from the optional native
 * permissions module, so it can run (and be tested) without touching the desktop.
 */

export type PlatformCheckCode =
	| "remote_host"
	| "unsupported_platform"
	| "linux_no_display"
	| "linux_wayland_only"
	| "macos_permissions_missing"

export interface PlatformCheckFailure {
	ok: false
	code: PlatformCheckCode
	message: string
	/** Steps the user can take. Shown to the user and returned to the model. */
	remedy: string[]
	/** macOS only: which permissions are missing. */
	missingPermissions?: MacPermission[]
}

export interface PlatformCheckSuccess {
	ok: true
	/** Non-blocking notes, for example "permissions could not be verified". */
	warnings: string[]
}

export type PlatformCheckResult = PlatformCheckSuccess | PlatformCheckFailure

export type MacPermission = "accessibility" | "screen"

export type MacAuthStatus = "authorized" | "denied" | "restricted" | "not determined"

/** Raw N-API exports of node-mac-permissions' permissions.node that we use. */
export interface MacPermissionsNative {
	getAuthStatus(type: string): MacAuthStatus
	askForAccessibilityAccess(): void
	askForScreenCaptureAccess(): void
}

export interface PlatformCheckOptions {
	platform?: string
	arch?: string
	env?: NodeJS.ProcessEnv
	/** vscode.env.remoteName. Set when the extension host runs over SSH, in a container, WSL, or Codespaces. */
	remoteName?: string
	/** Extension install path. Needed on macOS to load the bundled permissions module. */
	extensionPath?: string
	/** Opens the macOS permission prompts for missing permissions. Only set this in response to a user action. */
	requestMissingPermissions?: boolean
	/** Injectable for tests. */
	nativeRequire?: NativeRequire
}

/** <extensionPath>/dist/native/mac-permissions/permissions.node */
export function resolveMacPermissionsPath(extensionPath: string): string {
	return path.join(extensionPath, "dist", "native", "mac-permissions", "permissions.node")
}

const MAC_PERMISSION_LABELS: Record<MacPermission, string> = {
	accessibility: "Accessibility (mouse and keyboard control)",
	screen: "Screen Recording (screenshots)",
}

export function checkPlatform(options: PlatformCheckOptions = {}): PlatformCheckResult {
	const platform = options.platform ?? process.platform
	const arch = options.arch ?? process.arch
	const env = options.env ?? process.env
	const warnings: string[] = []

	// 1. Remote extension host: input would go to the remote machine, not the user's screen.
	if (options.remoteName) {
		return {
			ok: false,
			code: "remote_host",
			message: `Desktop control is disabled because the extension is running on a remote host (${options.remoteName}). Mouse, keyboard, and screenshots would act on that machine, not on your desktop.`,
			remedy: [
				"Open the folder locally (not over Remote SSH, Dev Containers, WSL, or Codespaces) to use desktop control.",
			],
		}
	}

	// 2. Bundled binary availability.
	if (!isPlatformSupported(platform, arch)) {
		return {
			ok: false,
			code: "unsupported_platform",
			message: `Desktop control is not available on ${platform}-${arch}.`,
			remedy: ["Supported platforms: macOS (Intel and Apple Silicon), Windows x64, Linux x64 with X11."],
		}
	}

	// 3. Linux display server.
	if (platform === "linux") {
		const hasX11 = !!env.DISPLAY
		const hasWayland = !!env.WAYLAND_DISPLAY

		if (!hasX11 && hasWayland) {
			return {
				ok: false,
				code: "linux_wayland_only",
				message:
					"Desktop control needs X11. This session is Wayland-only (WAYLAND_DISPLAY is set, DISPLAY is not).",
				remedy: [
					"Log in with an X11 session (for example 'Ubuntu on Xorg' on the login screen), or",
					"Enable XWayland so DISPLAY is set. Note: under XWayland only X11 apps can be controlled.",
				],
			}
		}

		if (!hasX11) {
			return {
				ok: false,
				code: "linux_no_display",
				message: "Desktop control needs a graphical X11 session, but DISPLAY is not set.",
				remedy: ["Run VS Code inside a desktop session with an X11 display."],
			}
		}

		if (hasWayland || env.XDG_SESSION_TYPE === "wayland") {
			warnings.push(
				"This is a Wayland session with XWayland. Screenshots and input may only work for X11 (XWayland) windows.",
			)
		}
	}

	// 4. macOS privacy permissions.
	if (platform === "darwin") {
		const permissions = loadMacPermissions(options)

		if (!permissions) {
			warnings.push(
				"Could not verify macOS Accessibility and Screen Recording permissions. If actions or screenshots fail, grant both to Visual Studio Code in System Settings > Privacy & Security.",
			)
		} else {
			const missing = getMissingMacPermissions(permissions)

			if (missing.length > 0) {
				if (options.requestMissingPermissions) {
					requestMacPermissions(permissions, missing)
				}

				return {
					ok: false,
					code: "macos_permissions_missing",
					message: `Desktop control needs these macOS permissions for Visual Studio Code: ${missing
						.map((p) => MAC_PERMISSION_LABELS[p])
						.join(", ")}.`,
					remedy: [
						"Open System Settings > Privacy & Security.",
						...missing.map((p) =>
							p === "accessibility"
								? "Under Accessibility, turn on Visual Studio Code."
								: "Under Screen & System Audio Recording, turn on Visual Studio Code.",
						),
						"Quit and reopen VS Code. macOS applies these permissions only after a restart.",
						"If VS Code is not in the list or the switch does not stay on, move Visual Studio Code.app into /Applications first. macOS does not keep permissions for apps run from Downloads or a disk image.",
					],
					missingPermissions: missing,
				}
			}
		}
	}

	return { ok: true, warnings }
}

function loadMacPermissions(options: PlatformCheckOptions): MacPermissionsNative | undefined {
	if (!options.extensionPath) {
		return undefined
	}

	const nativeRequire: NativeRequire = options.nativeRequire ?? require

	try {
		const native = nativeRequire(resolveMacPermissionsPath(options.extensionPath)) as Partial<MacPermissionsNative>
		if (
			typeof native?.getAuthStatus !== "function" ||
			typeof native.askForAccessibilityAccess !== "function" ||
			typeof native.askForScreenCaptureAccess !== "function"
		) {
			return undefined
		}
		return native as MacPermissionsNative
	} catch {
		return undefined
	}
}

export function getMissingMacPermissions(permissions: MacPermissionsNative): MacPermission[] {
	const missing: MacPermission[] = []
	for (const permission of ["accessibility", "screen"] as const) {
		let status: MacAuthStatus
		try {
			status = permissions.getAuthStatus(permission)
		} catch {
			// If the status cannot be read, do not block. The action itself will fail with a clearer error.
			continue
		}
		if (status !== "authorized") {
			missing.push(permission)
		}
	}
	return missing
}

function requestMacPermissions(permissions: MacPermissionsNative, missing: MacPermission[]): void {
	try {
		if (missing.includes("accessibility")) {
			permissions.askForAccessibilityAccess()
		}
		if (missing.includes("screen")) {
			permissions.askForScreenCaptureAccess()
		}
	} catch {
		// Prompts are best-effort. The remedy text explains the manual steps.
	}
}

/** Formats a failure for the model and the chat. */
export function formatPlatformCheckFailure(result: PlatformCheckFailure): string {
	return [result.message, "", "To fix this:", ...result.remedy.map((step, i) => `${i + 1}. ${step}`)].join("\n")
}
