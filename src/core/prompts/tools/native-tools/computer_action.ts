import type OpenAI from "openai"

const COMPUTER_ACTION_DESCRIPTION = `Control the user's desktop: take screenshots, move and click the mouse, type, press keys, scroll, and switch windows. This acts on the real screen of the user's computer, outside VS Code, so use it only when the task needs another desktop application and no file, command, browser_action, or MCP tool can do the job.

How it works:
- Start with action "screenshot" to see the screen. Every state-changing action returns a new screenshot of the result, unless you set screenshot to false.
- Coordinates are "x,y" in pixels of the most recent screenshot image (top-left is 0,0). They are scaled to the real screen automatically. Do not use real screen resolution.
- Each call may need the user's approval, and each call costs a full model turn. Do as much as you safely can per call.

Work fast:
- Batch predictable steps in one call with "actions" (1-10 steps), for example focus_window, click a field, type with submit. The steps run in order with one approval and one screenshot at the end. Leave out "action" when you use "actions".
- Batch steps allowed: click, double_click, right_click, move, drag, type, key, scroll, focus_window, wait, window_type, click_element. screenshot, list_windows, list_elements, and window_screenshot cannot be batch steps.
- Only batch steps whose targets you already know from the latest screenshot. If a step opens a menu or dialog whose layout you have not seen, end the batch there and look.
- If a step fails, the batch stops there. The result names the failed step, lists the steps that ran, and includes a screenshot when one can be taken.
- Use "submit": true on type to press Enter after the text, instead of a separate key step.
- Take a screenshot only when you need to see the result. Set "screenshot": false on a state-changing action or batch when you do not need to look (for example, when you will take more steps you are sure of). Read-only actions cannot use screenshot false.
- Before typing, make sure the right field has focus (click it first, in the same batch).
- Use list_windows and focus_window to bring an application to the front instead of searching for it visually.
- Clicking by coordinate can miss. On macOS, if a click misses or you are unsure of a position, use list_elements to read the window's buttons and fields by name, then click_element to press one. click_element does not move the pointer.
- Long text is pasted from the clipboard automatically (the user's clipboard is restored), so you can type whole paragraphs in one type action.
- Only the latest few screenshots stay in the conversation. Take a new screenshot rather than relying on an old one.

Sharing the computer with the user:
- The user may be using the mouse and keyboard at the same time. Actions that use them (click, move, drag, scroll, type, key, focus_window) wait until the user has paused, and the user's cursor is put back after each click or scroll.
- The user can turn on background mode (macOS). Then only screenshot, list_windows, wait, window_screenshot, window_type, list_elements, and click_element are allowed: press buttons with list_elements and click_element, and enter text with window_type. Other actions return an error.
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
- type: type text at the current focus; set submit to true to press Enter afterwards
- key: press a key or combination, for example "enter", "cmd+c", "ctrl+shift+t"
- scroll: scroll in direction by amount wheel steps, optionally at coordinate
- list_windows: list open windows with ids and titles (no screenshot)
- focus_window: bring a window to the front by id or title
- wait: wait duration milliseconds, then take a screenshot
- window_screenshot (macOS): capture only the given window, even when covered; does not move the cursor or change focus
- window_type (macOS): insert text at the given window's text cursor without bringing it to the front; returns a window_screenshot. It cannot press Enter, so submit is rejected; press the send button with click_element instead
- list_elements (macOS): list the buttons, fields, and menus of the given window by name, with their positions (no screenshot)
- click_element (macOS): press the element with the given name in the given window, without moving the pointer; returns a window_screenshot`

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
					type: ["string", "null"],
					description: `${ACTION_DESCRIPTION}\n\nRequired unless "actions" is given.`,
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
						"list_elements",
						"click_element",
						null,
					],
				},
				actions: {
					type: ["array", "null"],
					description:
						'Batch of 1-10 steps to run in order with one approval and one screenshot at the end. Each step has the same fields as a single call. Example: [{"action":"focus_window","window":"Notes"},{"action":"click","coordinate":"400,300"},{"action":"type","text":"hello","submit":true}]. Do not set "action" when you use this.',
					items: {
						type: "object",
						properties: {
							action: {
								type: "string",
								enum: [
									"click",
									"double_click",
									"right_click",
									"move",
									"drag",
									"type",
									"key",
									"scroll",
									"focus_window",
									"wait",
									"window_type",
									"click_element",
								],
							},
							coordinate: { type: ["string", "null"] },
							end_coordinate: { type: ["string", "null"] },
							text: { type: ["string", "null"] },
							key: { type: ["string", "null"] },
							direction: { type: ["string", "null"], enum: ["up", "down", "left", "right", null] },
							amount: { type: ["string", "null"] },
							window: { type: ["string", "null"] },
							element: { type: ["string", "null"] },
							duration: { type: ["string", "null"] },
							submit: { type: ["boolean", "null"] },
						},
						required: ["action"],
						additionalProperties: false,
					},
				},
				submit: {
					type: ["boolean", "null"],
					description:
						"For type: true presses Enter after the text. Not available for window_type (background typing cannot press Enter).",
				},
				screenshot: {
					type: ["boolean", "null"],
					description:
						"false: do not take a screenshot after a state-changing action or batch; the result is short text only. Default true. Not allowed on read-only actions (screenshot, list_windows, wait, window_screenshot, list_elements).",
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
						"Window id from list_windows, or part of the window title. Required for focus_window, window_screenshot, window_type, list_elements, and click_element.",
				},
				element: {
					type: ["string", "null"],
					description:
						'Element name from list_elements, for example "Save" or "Search". Exact names are matched first, then partial names. Required for click_element.',
				},
				duration: {
					type: ["string", "null"],
					description: "Milliseconds to wait, 0-10000. Default 1000.",
				},
			},
			required: [],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
