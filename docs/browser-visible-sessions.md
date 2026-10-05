# Local and visible browser sessions

## Select a browser

In **Roo Settings > Browser**, enable the browser tool and choose a local browser:

- **Managed Chromium** is the default. Roo resolves or downloads its managed Chromium installation when needed.
- **Installed Google Chrome (macOS/Windows)** uses Chrome already installed on the machine running the VS Code extension host. Roo checks standard system and per-user application locations. It does not download Chrome, search the network, or silently fall back to Chromium if Chrome is unavailable. On Linux, select managed Chromium or a trusted remote browser instead.

Save the settings, close any existing browser session, and launch a new session to apply the selection.

Both choices use a fresh, isolated Roo profile. Roo does not use your personal Chrome profile, cookies, or signed-in accounts. Closing a session deletes only that session's temporary profile; launching another session does not delete profiles owned by other VS Code windows. Profiles left by an interrupted extension host are not automatically reclaimed by another launch.

## Show a browser window

Select **Show browser window** and save settings. Existing installations default to headless mode. Close the current session and launch a new one after changing this setting.

Native macOS and Windows launches do not require Linux display environment variables. Linux uses X11 when DISPLAY is present, or Wayland when only WAYLAND_DISPLAY is present. Without either variable, Roo falls back to headless mode. Display variables do not guarantee access to a working desktop.

The browser runs on the **extension host**, not necessarily on your local desktop. For SSH, containers, WSL, or code-server, installing Chrome on the computer displaying VS Code does not make it available on a different extension host. A visible window requires an accessible desktop on that host.

Local launches retain the browser's sandbox and native user agent. Roo does not retry with sandbox-disabled flags or change host security policy. Linux root requests for a visible browser fall back to headless mode without disabling the sandbox, so Chromium can still reject the launch. Display or sandbox failures preserve the underlying error and clean up the failed launch's owned profile. A non-root, sandbox-capable extension host is recommended.

## Screenshot write permissions

Saving a screenshot to disk requires destination-specific file-write approval. Browser auto-approval alone does not authorize a screenshot file write. Existing file-write auto-approval and protected-file policies apply.

The destination must be inside the workspace, allowed by ignore rules, and permitted by the active mode's file-writing restrictions. Symlink paths and hard-linked destination files are rejected. These checks run again after approval and before writing. Ordinary browser interactions and in-memory full-page captures do not require file-write approval.

The filesystem checks mitigate path-redirection races but are not a complete sandbox against another process concurrently replacing workspace directories.

## Remote browsers

Remote mode disables the local browser selection and visibility controls without clearing the saved local preference. It connects to the configured debugging endpoint instead of launching either local browser. A failed remote connection reports an error instead of silently starting a local browser.

Use a trusted, sandboxed remote browser whose debugging endpoint is reachable only by trusted clients. Roo cannot verify or repair an external browser's sandbox policy. Disconnecting Roo does not close the externally managed browser.

## Validation and deployment limits

The regression tests cover default Chromium selection, standard Chrome installation discovery, missing/unsupported Chrome errors, no download or fallback for Chrome, isolated profiles, concurrent-session cleanup, platform-specific visibility, and screenshot write authorization. Settings tests cover persistence, saved values, selection changes, and remote-mode disabling. Panel tests cover activity updates after initial hydration.

Browser launch tests use mocks. Real macOS and Windows desktop launches, installed Chrome compatibility, and usable Linux sandbox/display access require separate platform testing. Source edits require rebuilding and deployment; after installing an updated extension, reload the VS Code window to activate it.

Run focused backend tests from the backend workspace and UI tests from the webview workspace. Type checks and lint should also run in their owning workspaces before packaging.
