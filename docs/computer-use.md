# Desktop control (computer use)

Desktop control lets Roo work in other applications on your computer. Roo can take screenshots, move and click the mouse, type, press keys, scroll, and switch windows. The model uses the `computer_action` tool to do this.

> **Warning:** With desktop control on, the agent can see your screen and use your mouse and keyboard in any app. It can send messages, delete data, and change settings, just as you can. Approve each action only after you read it.

## Requirements

- **A vision-capable model.** The agent works from screenshots. If the selected model does not accept images, Roo hides the tool.
- **Any mode.** Since 4.2.76 the tool is available in every mode, including Architect, Ask, Debug, Orchestrator, and custom modes, when desktop control is on. Read-only modes such as Ask and Architect can then click and type in other apps. Approval and the app allowlist still apply. To keep a mode away from the desktop, add `computer_action` to `disabledTools` or turn desktop control off.
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

A batch (see [Batched actions](#batched-actions)) asks once for all its steps. The approval lists every step in order, with the full text of each `type` step, and says when Enter will be pressed.

### Auto-approval is a separate opt-in

**Settings > Auto-Approve > Desktop control** approves every desktop action without asking. Turn it on only if you trust the task and the allowed apps.

- **Always allow all does not include desktop control.** You must turn on the Desktop control toggle separately.
- The **All** button in the chat auto-approve menu also skips desktop control.
- The master auto-approve switch must also be on.

### App allowlist

**Allowed apps** limits which windows Roo can act on. Enter one entry per line. Each entry matches any part of a window title, and case does not matter.

- If the list is empty, every app is allowed.
- If the list has entries, actions that change something (click, type, key, scroll, drag) run only when the active window title matches an entry. A `focus_window` action runs only when the target window matches.
- In a batch, Roo checks every step before it asks you. It checks again before each step runs, because an earlier step can change the active window. If a step targets a window that is not allowed, the batch stops at that step.
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

Stopping cancels every task that is controlling the desktop, in all Roo panels. The status bar item is shown while an action runs and for 10 seconds afterwards. If a batch is running, the steps that have not started do not run.

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
| `type`                                 | `text` (up to 10,000 characters), optional `submit`                             | Screenshot                                        |
| `key`                                  | `key`, for example `enter`, `cmd+c`, `ctrl+shift+t`                             | Screenshot                                        |
| `scroll`                               | `direction` (default `down`), `amount` (1-50, default 3), optional `coordinate` | Screenshot                                        |
| `list_windows`                         | none                                                                            | List of window ids and titles, with no screenshot |
| `focus_window`                         | `window` (id or part of the title)                                              | Screenshot                                        |
| `wait`                                 | `duration` in ms (0-10,000, default 1,000)                                      | Screenshot                                        |
| `window_screenshot` (macOS)            | `window` (id or part of the title)                                              | Screenshot of that window only                    |
| `window_type` (macOS)                  | `window`, `text`                                                                | Screenshot of that window only                    |
| `list_elements` (macOS)                | `window`                                                                        | Buttons, fields, and menus by name and position   |
| `click_element` (macOS)                | `window`, `element` (name from `list_elements`)                                 | Screenshot of that window only                    |

### Batched actions

Each tool call costs a full model turn, which takes much longer than the action itself. To save turns, Roo can send up to 10 steps in one call with the `actions` parameter:

```json
{
	"actions": [
		{ "action": "focus_window", "window": "Notes" },
		{ "action": "click", "coordinate": "400,300" },
		{ "action": "type", "text": "Buy milk", "submit": true }
	]
}
```

- Allowed steps: `click`, `double_click`, `right_click`, `move`, `drag`, `type`, `key`, `scroll`, `focus_window`, `wait`, `window_type`, `click_element`.
- Not allowed as steps: `screenshot`, `list_windows`, `list_elements`, `window_screenshot`. The batch already returns one screenshot at the end.
- Do not give `action` and `actions` in the same call.
- Roo checks every step before it asks for approval: required parameters, the app allowlist, and background mode. An invalid batch is refused without asking you.
- The steps run in order. Each step that uses the mouse or keyboard still waits until you pause. There is no screen settle wait between steps, only a 50 ms gap. After the last step, Roo waits once for the screen to settle and takes one screenshot.
- If a step fails, the batch stops. The result names the failed step, says how many steps finished, and includes a screenshot when one can be taken.
- The result lists the steps that ran, with the screen coordinates that were used.

### Press Enter after typing

Set `"submit": true` on a `type` action (or `type` step) to press Enter after the text. This replaces a separate `key` action.

`submit` is not available for `window_type`. Background typing inserts text through Accessibility and cannot press Enter. Roo refuses the call and says to use `click_element` on the send button instead.

### Skip the screenshot

Set `"screenshot": false` on a state-changing action, or on a batch, to skip the settle wait and the screenshot. The result is a short text with no image. Use this when the next step does not depend on what the screen shows. Read-only actions (`screenshot`, `list_windows`, `wait`, `window_screenshot`, `list_elements`) cannot use it.

### Using the computer at the same time as Roo

Roo and you share one mouse pointer and one keyboard focus. Roo takes turns with you:

- Before a click, move, drag, scroll, type, key, or focus action, Roo checks whether you used the mouse or keyboard recently. If you did, it waits until you pause for about 1.5 seconds.
- If you keep working for 20 seconds, the action does not run, and Roo is told that you are busy.
- After a click, drag, or scroll, Roo puts your pointer back where it was.
- Screenshots and window listing never wait.

On macOS, Roo can also keep working in the background while you use the computer:

- `window_screenshot` captures one window, even when other windows cover it. It does not move the pointer or change the front app.
- `window_type` inserts text at the text cursor of a window through Accessibility, without bringing the window to the front. It works in native apps such as TextEdit, Notes, and Mail. Browsers and Electron apps may ignore it.
- `list_elements` lists the buttons, text fields, and menus of a window by name. `click_element` presses one by name through Accessibility, without moving the pointer. Use these when a click by coordinate misses, or to click while you are busy. Apps that do not expose Accessibility names (some games and custom-drawn apps) cannot be used this way.

On Windows and Linux, only turn-taking is available.

### Background mode (macOS)

Turn on **Settings > Computer Use > Background mode** to let Roo work without ever taking your pointer, keyboard, or front window. You can keep using the computer the whole time.

In background mode Roo can only use these actions:

- `screenshot`, `list_windows`, `wait`
- `window_screenshot`: see one window, even when it is covered
- `list_elements` and `click_element`: find and press buttons, menus, and fields by name
- `window_type`: type into a window's text field without bringing it to the front

Clicking by position, moving the pointer, dragging, scrolling, key shortcuts, and `focus_window` are refused, and Roo is told which actions it can use instead. If a task cannot be done this way (for example, an app with no Accessibility names, or a drag-and-drop), Roo asks you to turn background mode off.

Background mode is off by default. On Windows and Linux the setting has no effect except that every action is refused, so leave it off there.

### Coordinates

Coordinates are `"x,y"` in pixels of the latest screenshot. Screenshots are scaled down to fit 1280 x 800, so they are smaller than the real screen. Roo converts screenshot pixels to real screen positions, and this includes Retina and Windows display scaling.

### Keys

In key combinations, `cmd` means the main shortcut key: Command on macOS and Ctrl on Windows and Linux. `win`, `super`, and `meta` always mean the OS key. Other modifiers are `ctrl`, `alt` (or `option`), and `shift`.

### Screenshots and typing

- After an action that changes something, Roo waits 200 ms for the screen to settle before it takes the screenshot.
- On macOS, screenshots use the system capture tool and are sent as JPEG (about 0.3-0.5 s and 100-200 KB each). If that fails, Roo falls back to the built-in capture and PNG.
- Only the 3 most recent desktop screenshots stay in the conversation. Older ones are replaced with a short note, so long desktop tasks do not fill the context with stale images.
- Text longer than 40 characters is pasted from the clipboard instead of typed key by key. This is faster, and autocorrect does not change it. Roo restores your clipboard right after. Short text is typed normally.

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
| Roo does not offer the tool                  | Use a vision-capable model and turn on the setting.                       |
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
