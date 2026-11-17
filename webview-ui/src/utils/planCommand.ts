/**
 * Parses the chat-input plan overlay commands:
 * - "/plan" turns the overlay on;
 * - "/plan <text>" turns it on and sends <text> as the next message;
 * - "/plan off" turns it off.
 * Returns undefined for any other input (including "/planner" or a mid-text "/plan").
 */
export function parsePlanCommand(input: string): { on: boolean; text?: string } | undefined {
	const trimmed = input.trim()
	if (trimmed === "/plan") return { on: true }
	if (trimmed === "/plan off") return { on: false }
	const match = /^\/plan\s+([\s\S]+)$/.exec(trimmed)
	if (!match) return undefined
	return { on: true, text: match[1].trim() }
}
