# Visible browser sessions

In Roo Settings > Browser, enable the browser tool and select **Show browser window**, then save settings. Close any existing browser session and launch a new one. Existing installations default to headless mode until this option is selected.

The window opens on the machine running the VS Code extension host. For SSH, containers, or code-server, this is not necessarily the user's desktop. An accessible graphical session is required. Linux uses X11 when DISPLAY is present, or explicitly selects Wayland when only WAYLAND_DISPLAY is present. Display environment variables alone do not guarantee access to a working display.

Both visible and headless local launches retain Chromium's sandbox and native user agent. There is no sandbox-disable setting and no retry with unsafe flags. Linux root execution is rejected before Chromium resolution/download. Display or sandbox launch failures preserve the underlying error, clean up the failed launch's profile, and provide next steps.

## Remote browsers

The existing remote connection setting remains available. Local visibility settings do not change the remote browser's mode. Use a trusted browser that is already visible and sandboxed, with a debugging endpoint reachable only by trusted clients. Roo cannot verify or repair the sandbox policy of an externally started browser. Failed remote discovery/connection now reports an error instead of silently launching a local browser.

## Host prerequisites and deployment

A source change cannot make an unavailable Chromium sandbox usable. On the Ubuntu host used for this work, a previous non-root Chromium launch failed with `No usable sandbox` under AppArmor user-namespace restrictions. Running the extension host as non-root is necessary but not sufficient. An administrator-approved sandbox-capable environment or an existing trusted remote browser is still required. This feature does not change AppArmor, kernel settings, permissions, or install sandbox helpers.

Tests mock browser launch and do not demonstrate a working graphical browser on this host. No browser was launched during implementation. No live AA inventory was retrieved or manually verified. No CAPTCHA automation was added. Human verification must happen in an operational visible session, with agent actions paused while the human interacts.

The test script's pretest hook built local bundles during validation. No VSIX was installed and no extension was reloaded. Packaging and deployment require separate approval; the running extension should not be assumed to contain these changes.

## Validation

Run from the repository root, using pnpm 10.8.1:

```sh
pnpm --dir src exec vitest run services/browser/__tests__/BrowserSession.spec.ts
pnpm --dir webview-ui exec vitest run src/components/settings/__tests__/BrowserSettings.spec.tsx
pnpm --filter @roo-code/types check-types
pnpm --filter roo-cline check-types
pnpm --filter @roo-code/vscode-webview check-types
```

The launch suite covers default/headed/headless sandbox-preserving options, native user agent, root rejection, missing display, Wayland-only selection, non-Linux behavior, sandbox/display errors, failed-launch cleanup, no local fallback, and remote disconnect semantics. The UI suite covers the default, changed value propagation, saved value, and remote-mode disabling. These are mocked regressions, not end-to-end display or sandbox verification.
