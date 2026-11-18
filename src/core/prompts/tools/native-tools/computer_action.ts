import type OpenAI from "openai"

const COMPUTER_ACTION_DESCRIPTION = `Control the user's desktop: take screenshots, move and click the mouse, type, press keys, scroll, and switch windows. This acts on the real screen of the user's computer, outside VS Code, so use it only when the task needs another desktop application and no file, command, browser_action, or MCP tool can do the job.

How it works:
- Start with action "screenshot" to see the screen. Every state-changing action returns a new screenshot of the result.
- Coordinates are "x,y" in pixels of the most recent screenshot image (top-left is 0,0). They are scaled to the real screen automatically. Do not use real screen resolution.
- One action per call. Look at the returned screenshot before you choose the next action.
- Each action may need the user's approval. Keep the number of actions small.
- Before typing, make sure the right field has focus (click it first).
- Use list_windows and focus_window to bring an application to the front instead of searching for it visually.

Sharing the computer with the user:
- The user may be using the mouse and keyboard at the same time. Actions that use them (click, move, drag, scroll, type, key, focus_window) wait until the user has paused, and the user's cursor is put back after each click or scroll.
- If an action fails because the user is busy, use wait and try again. On macOS you can instead keep working without the shared cursor: window_screenshot shows one window even when it is covered, and window_type inserts text at that window's text cursor without bringing it to the front. Pixels in a window_screenshot are window pixels, not screen coordinates, so never click using them.`

const SAFETY_DESCRIPTION = `Safety:
- Do not enter passwords, payment details, or other secrets unless the user explicitly provided them for this purpose.
- Do not send messages, make purchases, delete data, or change system settings unless the user asked for that specific action.
- If something unexpected appears (a dialog, a login page, a security prompt), stop and ask the user.`

const ACTION_DESCRIPTION = `Action to perform:
- screenshot: capture the screen
- click, double_click, right_click: click at coordinate
- move: move the mouse to coordinate
- drag: press at coordinate, move to end_coordinate, release
- type: type text at the current focus
- key: press a key or combination, for example "enter", "cmd+c", "ctrl+shift+t"
- scroll: scroll in direction by amount wheel steps, optionally at coordinate
- list_windows: list open windows with ids and titles (no screenshot)
- focus_window: bring a window to the front by id or title
- wait: wait duration milliseconds, then take a screenshot
- window_screenshot (macOS): capture only the given window, even when covered; does not move the cursor or change focus
- window_type (macOS): insert text at the given window's text cursor without bringing it to the front; returns a window_screenshot`

export default {
	type: "function",
	function: {
		name: "computer_action",
		description: `${COMPUTER_ACTION_DESCRIPTION}\n\n${SAFETY_DESCRIPTION}`,
		strict: false,
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					description: ACTION_DESCRIPTION,
					enum: [
						"screenshot",
						"click",
						"double_click",
						"right_click",
						"move",
						"drag",
						"type",
						"key",
						"scroll",
						"list_windows",
						"focus_window",
						"wait",
						"window_screenshot",
						"window_type",
					],
				},
				coordinate: {
					type: ["string", "null"],
					description:
						'"x,y" in pixels of the latest screenshot. Required for click, double_click, right_click, move, drag. Optional for scroll.',
				},
				end_coordinate: {
					type: ["string", "null"],
					description: '"x,y" end point in screenshot pixels. Required for drag.',
				},
				text: {
					type: ["string", "null"],
					description: "Text to type. Required for type and window_type.",
				},
				key: {
					type: ["string", "null"],
					description:
						'Key or combination for key, joined with "+". Modifiers: cmd (Command on macOS, Ctrl elsewhere), ctrl, alt/option, shift, win/super. Keys: a single character, enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f24.',
				},
				direction: {
					type: ["string", "null"],
					enum: ["up", "down", "left", "right", null],
					description: "Scroll direction. Default down.",
				},
				amount: {
					type: ["string", "null"],
					description: "Scroll amount in wheel steps, 1-50. Default 3.",
				},
				window: {
					type: ["string", "null"],
					description:
						"Window id from list_windows, or part of the window title. Required for focus_window, window_screenshot, and window_type.",
				},
				duration: {
					type: ["string", "null"],
					description: "Milliseconds to wait, 0-10000. Default 1000.",
				},
			},
			required: ["action"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
