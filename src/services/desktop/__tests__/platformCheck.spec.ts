import {
	checkPlatform,
	formatPlatformCheckFailure,
	resolveMacPermissionsPath,
	type MacAuthStatus,
	type PlatformCheckFailure,
} from "../platformCheck"

function macPermissions(status: Partial<Record<string, MacAuthStatus>>) {
	return {
		getAuthStatus: vi.fn((type: string) => status[type] ?? "authorized"),
		askForAccessibilityAccess: vi.fn(),
		askForScreenCaptureAccess: vi.fn(),
	}
}

describe("checkPlatform", () => {
	it("refuses on a remote extension host before anything else", () => {
		const nativeRequire = vi.fn()
		const result = checkPlatform({ platform: "darwin", arch: "arm64", remoteName: "ssh-remote", nativeRequire })
		expect(result).toMatchObject({ ok: false, code: "remote_host" })
		expect(nativeRequire).not.toHaveBeenCalled()
	})

	it("refuses unsupported platform and arch pairs", () => {
		expect(checkPlatform({ platform: "linux", arch: "arm64", env: { DISPLAY: ":0" } })).toMatchObject({
			ok: false,
			code: "unsupported_platform",
		})
	})

	it("accepts Windows x64 with no warnings", () => {
		expect(checkPlatform({ platform: "win32", arch: "x64", env: {} })).toEqual({ ok: true, warnings: [] })
	})

	describe("linux", () => {
		it("accepts X11", () => {
			expect(checkPlatform({ platform: "linux", arch: "x64", env: { DISPLAY: ":0" } })).toEqual({
				ok: true,
				warnings: [],
			})
		})

		it("refuses Wayland-only sessions", () => {
			expect(
				checkPlatform({ platform: "linux", arch: "x64", env: { WAYLAND_DISPLAY: "wayland-0" } }),
			).toMatchObject({ ok: false, code: "linux_wayland_only" })
		})

		it("refuses when there is no display at all", () => {
			expect(checkPlatform({ platform: "linux", arch: "x64", env: {} })).toMatchObject({
				ok: false,
				code: "linux_no_display",
			})
		})

		it("warns under XWayland", () => {
			const result = checkPlatform({
				platform: "linux",
				arch: "x64",
				env: { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
			})
			expect(result.ok).toBe(true)
			expect(result.ok && result.warnings[0]).toMatch(/XWayland/)
		})
	})

	describe("macOS", () => {
		it("loads the permissions module from the bundled path", () => {
			const nativeRequire = vi.fn(() => macPermissions({}))
			checkPlatform({ platform: "darwin", arch: "arm64", extensionPath: "/ext", nativeRequire })
			expect(nativeRequire).toHaveBeenCalledWith(resolveMacPermissionsPath("/ext"))
		})

		it("passes when both permissions are authorized", () => {
			const nativeRequire = vi.fn(() => macPermissions({}))
			expect(checkPlatform({ platform: "darwin", arch: "arm64", extensionPath: "/ext", nativeRequire })).toEqual({
				ok: true,
				warnings: [],
			})
		})

		it("reports each missing permission and does not prompt by default", () => {
			const perms = macPermissions({ accessibility: "denied", screen: "not determined" })
			const result = checkPlatform({
				platform: "darwin",
				arch: "x64",
				extensionPath: "/ext",
				nativeRequire: () => perms,
			}) as PlatformCheckFailure

			expect(result).toMatchObject({
				ok: false,
				code: "macos_permissions_missing",
				missingPermissions: ["accessibility", "screen"],
			})
			expect(perms.askForAccessibilityAccess).not.toHaveBeenCalled()
			expect(perms.askForScreenCaptureAccess).not.toHaveBeenCalled()
		})

		it("opens only the prompts for missing permissions when requested", () => {
			const perms = macPermissions({ screen: "denied" })
			checkPlatform({
				platform: "darwin",
				arch: "arm64",
				extensionPath: "/ext",
				nativeRequire: () => perms,
				requestMissingPermissions: true,
			})
			expect(perms.askForAccessibilityAccess).not.toHaveBeenCalled()
			expect(perms.askForScreenCaptureAccess).toHaveBeenCalledOnce()
		})

		it("warns instead of failing when the permissions module cannot load", () => {
			const result = checkPlatform({
				platform: "darwin",
				arch: "arm64",
				extensionPath: "/ext",
				nativeRequire: () => {
					throw new Error("not found")
				},
			})
			expect(result.ok).toBe(true)
			expect(result.ok && result.warnings[0]).toMatch(/Could not verify/)
		})

		it("does not block when a single status read throws", () => {
			const perms = macPermissions({})
			perms.getAuthStatus.mockImplementation((type: string) => {
				if (type === "screen") throw new Error("boom")
				return "authorized"
			})
			expect(
				checkPlatform({ platform: "darwin", arch: "arm64", extensionPath: "/ext", nativeRequire: () => perms }),
			).toEqual({ ok: true, warnings: [] })
		})
	})

	it("formats a failure as numbered steps", () => {
		const text = formatPlatformCheckFailure({
			ok: false,
			code: "linux_no_display",
			message: "No display.",
			remedy: ["Do A.", "Do B."],
		})
		expect(text).toBe("No display.\n\nTo fix this:\n1. Do A.\n2. Do B.")
	})
})
