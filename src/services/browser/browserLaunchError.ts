/** Never work around host sandbox failures by weakening Chromium security. */
export function browserLaunchError(error: unknown, browser: string): Error {
	return new Error(
		`Failed to launch sandboxed ${browser}. ` +
			"Run the extension host as a non-root user with a usable Chromium sandbox. " +
			"On Linux, AppArmor or user-namespace restrictions may require administrator review; Roo does not change host security policy. " +
			"For visible sessions, verify access to the X11 or Wayland display. " +
			"No sandbox-disabled fallback was attempted. " +
			`Original error: ${error instanceof Error ? error.message : String(error)}`,
	)
}
