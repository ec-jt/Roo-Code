/** Never work around host sandbox failures by weakening Chromium security. */
export function browserLaunchError(error: unknown, browser: string, executablePath?: string): Error {
	return new Error(
		`Failed to launch sandboxed ${browser}. ` +
			`The browser runs on the VS Code extension host (${process.platform}), which is the server in Remote SSH, not the computer displaying VS Code. ` +
			(executablePath ? `Browser executable: ${executablePath}. ` : "") +
			"Run the extension host as a non-root user with a usable Chromium sandbox. " +
			"On Linux, AppArmor or user-namespace restrictions may require administrator review; Roo does not change host security policy. " +
			"For headless Linux, leave Show browser window off. Try an administrator-installed Google Chrome with a working sandbox, or connect to a trusted browser through a private SSH tunnel using Remote browser settings. " +
			"For visible sessions, verify access to the X11 or Wayland display. " +
			"No sandbox-disabled fallback was attempted. " +
			`Original error: ${error instanceof Error ? error.message : String(error)}`,
	)
}
