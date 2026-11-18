# Desktop control (computer use)

Desktop control lets Roo work in other applications on your computer. Roo can take screenshots, move and click the mouse, type, press keys, scroll, and switch windows. The model uses the `computer_action` tool to do this.

> **Warning:** With desktop control on, the agent can see your screen and use your mouse and keyboard in any app. It can send messages, delete data, and change settings, just as you can. Approve each action only after you read it.

## Requirements

- **A vision-capable model.** The agent works from screenshots. If the selected model does not accept images, Roo hides the tool.
- **Code mode.** The tool belongs to the `computer` tool group. Only the built-in Code mode includes this group. To use it in a custom mode, add `computer` to that mode's groups.
- **A local VS Code window.** The tool acts on the machine that runs the extension host. Over Remote SSH, Dev Containers, WSL, or Codespaces, that machine is not your desktop, so the tool refuses to run.
- **A supported platform:**

| Platform                       | Supported | Notes                                                                                     |
| ------------------------------ | --------- | ----------------------------------------------------------------------------------------- |
| macOS, Apple Silicon and Intel | Yes       | Needs 2 privacy permissions (see below).                                                  |
| Windows x64                    | Yes       | Cannot control apps that run as Administrator unless VS Code also runs as Administrator.  |
| Linux x64 with X11             | Yes       | Wayland-only sessions are not supported. Under XWayland, only X11 apps can be controlled. |
| Windows ARM64, Linux ARM64     | No        | No prebuilt binary exists for these platforms.                                            |

## Turn it on

1. Open Roo **Settings > Computer Use**.
2. Select **Enable desktop control**.
3. Optional: add entries under **Allowed apps** (see [App allowlist](#app-allowlist)).
4. On macOS, click **Check / request macOS permissions** and follow the steps in the next section.
5. Click **Save**.

## macOS permissions

macOS grants these permissions to the app that runs Roo, which is **Visual Studio Code**. They are not granted to Roo itself.

1. Move `Visual Studio Code.app` into `/Applications` if it is not there already. macOS does not keep permissions for apps that run from Downloads or from a disk image.
2. In Roo **Settings > Computer Use**, click **Check / request macOS permissions**. macOS shows a prompt for each missing permission.
3. Open **System Settings > Privacy & Security**.
4. Under **Accessibility**, turn on **Visual Studio Code**. Mouse and keyboard control need this permission.
5. Under **Screen & System Audio Recording**, turn on **Visual Studio Code**. Screenshots need this permission.
6. Quit VS Code completely (Cmd+Q) and open it again. macOS applies these permissions only after the app restarts.
7. Click **Check / request macOS permissions** again. The result must say **Desktop control is available**.

If screenshots are black or empty, the Screen Recording permission is missing or VS Code has not restarted.

## Linux

1. Log in to an X11 session, for example "Ubuntu on Xorg" on the login screen.
2. Check that `echo $DISPLAY` prints a value such as `:0`.

If only `WAYLAND_DISPLAY` is set, the tool refuses to run and shows these steps.

## Approvals and safety

### Every action asks first

By default, Roo shows each desktop action and waits for **Approve** or **Reject**. For `type` actions, the approval shows the full text that Roo will type.

### Auto-approval is a separate opt-in

**Settings > Auto-Approve > Desktop control** approves every desktop action without asking. Turn it on only if you trust the task and the allowed apps.

- **Always allow all does not include desktop control.** You must turn on the Desktop control toggle separately.
- The **All** button in the chat auto-approve menu also skips desktop control.
- The master auto-approve switch must also be on.

### App allowlist

**Allowed apps** limits which windows Roo can act on. Enter one entry per line. Each entry matches any part of a window title, and case does not matter.

- If the list is empty, every app is allowed.
- If the list has entries, actions that change something (click, type, key, scroll, drag) run only when the active window title matches an entry. A `focus_window` action runs only when the target window matches.
- Screenshots, window listing, and wait are always allowed.
- The allowlist applies even when auto-approval is on.

Example:

```
Safari
Notes
```

### Stop desktop control

Use one of these:

- Press **Cmd+Alt+Shift+X** (macOS) or **Ctrl+Alt+Shift+X** (Windows, Linux). VS Code receives the shortcut only when one of its windows has focus. If another app is in front, click the VS Code window first.
- Click **Roo is controlling the desktop** in the VS Code status bar.
- Run **Roo Code: Stop Desktop Control** from the Command Palette.

Stopping cancels every task that is controlling the desktop, in all Roo panels. The status bar item is shown while an action runs and for 10 seconds afterwards.

### What the agent is told

The tool description tells the model to:

- Prefer files, commands, the browser tool, and MCP tools over desktop control.
- Not enter secrets, send messages, make purchases, delete data, or change system settings unless you asked for that specific action.
- Stop and ask you if an unexpected dialog, login page, or security prompt appears.

These are instructions to the model. They are not enforced limits. Approval, the allowlist, and the stop command are the enforced controls.

## Actions

| Action                                 | Parameters                                                                      | Result                                            |
| -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `screenshot`                           | none                                                                            | Screenshot                                        |
| `click`, `double_click`, `right_click` | `coordinate`                                                                    | Screenshot after the click                        |
| `move`                                 | `coordinate`                                                                    | Screenshot                                        |
| `drag`                                 | `coordinate`, `end_coordinate`                                                  | Screenshot                                        |
| `type`                                 | `text` (up to 10,000 characters)                                                | Screenshot                                        |
| `key`                                  | `key`, for example `enter`, `cmd+c`, `ctrl+shift+t`                             | Screenshot                                        |
| `scroll`                               | `direction` (default `down`), `amount` (1-50, default 3), optional `coordinate` | Screenshot                                        |
| `list_windows`                         | none                                                                            | List of window ids and titles, with no screenshot |
| `focus_window`                         | `window` (id or part of the title)                                              | Screenshot                                        |
| `wait`                                 | `duration` in ms (0-10,000, default 1,000)                                      | Screenshot                                        |
| `window_screenshot` (macOS)            | `window` (id or part of the title)                                              | Screenshot of that window only                    |
| `window_type` (macOS)                  | `window`, `text`                                                                | Screenshot of that window only                    |

### Using the computer at the same time as Roo

Roo and you share one mouse pointer and one keyboard focus. Roo takes turns with you:

- Before a click, move, drag, scroll, type, key, or focus action, Roo checks whether you used the mouse or keyboard recently. If you did, it waits until you pause for about 1.5 seconds.
- If you keep working for 20 seconds, the action does not run, and Roo is told that you are busy.
- After a click, drag, or scroll, Roo puts your pointer back where it was.
- Screenshots and window listing never wait.

On macOS, Roo can also keep working in the background while you use the computer:

- `window_screenshot` captures one window, even when other windows cover it. It does not move the pointer or change the front app.
- `window_type` inserts text at the text cursor of a window through Accessibility, without bringing the window to the front. It works in native apps such as TextEdit, Notes, and Mail. Browsers and Electron apps may ignore it.
- Clicking in the background is not supported. To click, Roo waits for its turn.

On Windows and Linux, only turn-taking is available.

### Coordinates

Coordinates are `"x,y"` in pixels of the latest screenshot. Screenshots are scaled down to fit 1280 x 800, so they are smaller than the real screen. Roo converts screenshot pixels to real screen positions, and this includes Retina and Windows display scaling.

### Keys

In key combinations, `cmd` means the main shortcut key: Command on macOS and Ctrl on Windows and Linux. `win`, `super`, and `meta` always mean the OS key. Other modifiers are `ctrl`, `alt` (or `option`), and `shift`.

## Limits

- **Primary display only.** Roo cannot see or click on other monitors.
- **Screenshot speed.** Roo scales and encodes screenshots in JavaScript, so very large displays (5K and above) can add a noticeable delay to each action.
- **Elevated windows on Windows.** Windows blocks input to apps that run as Administrator.
- **Wayland.** Not supported.
- **ARM64 Windows and Linux.** Not supported.

## Troubleshooting

| Message or symptom                           | Fix                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| "Desktop control is turned off"              | Turn on **Enable desktop control** in **Settings > Computer Use**.        |
| Roo does not offer the tool                  | Use Code mode and a vision-capable model, and turn on the setting.        |
| "running on a remote host"                   | Open the folder locally, not through a remote connection.                 |
| "needs these macOS permissions"              | Follow [macOS permissions](#macos-permissions), and restart VS Code.      |
| Black or empty screenshots                   | Grant Screen Recording to Visual Studio Code, then restart VS Code.       |
| "Wayland-only"                               | Log in to an X11 session.                                                 |
| "not in the Computer Use app allowlist"      | Bring an allowed app to the front, or edit **Allowed apps**.              |
| "Failed to load the desktop control library" | Reinstall the extension. The bundled native files are missing or blocked. |

## For developers

- Code: `src/services/desktop/` (driver, session, platform checks, image encoding, key parser) and `src/core/tools/ComputerActionTool.ts`.
- Native binaries: `@nut-tree-fork/libnut-{darwin,win32,linux}@2.7.5` and `@nut-tree-fork/node-mac-permissions@2.2.1`. All are N-API modules, pinned to exact versions. The build copies them to `dist/native/`. On Windows, the build also copies the MSVC runtime DLLs next to `libnut.node`.
    - `node-mac-permissions` installs only on macOS. A VSIX built on another OS has no macOS permission check, and the check shows a warning instead.
    - The extension loads the binaries by explicit path, so `bindings` lookups are not used.
- Tests: `cd src && npx vitest run services/desktop core/tools/__tests__/computerActionTool.spec.ts`
