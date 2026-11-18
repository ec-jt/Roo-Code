import type { KeyModifier } from "./DesktopDriver"

/**
 * Parse key combinations such as "cmd+c", "ctrl+shift+t", "enter", "f5", or "ctrl++".
 * Output uses libnut key and modifier names.
 */

export interface ParsedKeyCombo {
	key: string
	modifiers: KeyModifier[]
}

export class KeyParseError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "KeyParseError"
	}
}

const NAMED_KEYS = new Set<string>([
	"backspace",
	"delete",
	"enter",
	"tab",
	"escape",
	"up",
	"down",
	"left",
	"right",
	"home",
	"end",
	"pageup",
	"pagedown",
	"space",
	"insert",
	"printscreen",
	"menu",
	"audio_mute",
	"audio_vol_down",
	"audio_vol_up",
	"audio_play",
	"audio_stop",
	"audio_pause",
	"audio_prev",
	"audio_next",
	...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
	...Array.from({ length: 10 }, (_, i) => `numpad_${i}`),
])

const KEY_ALIASES: Record<string, string> = {
	return: "enter",
	esc: "escape",
	del: "delete",
	bksp: "backspace",
	pgup: "pageup",
	pgdn: "pagedown",
	page_up: "pageup",
	page_down: "pagedown",
	arrowup: "up",
	arrowdown: "down",
	arrowleft: "left",
	arrowright: "right",
	spacebar: "space",
	ins: "insert",
	prtsc: "printscreen",
	print: "printscreen",
	plus: "+",
	minus: "-",
}

type ModifierToken = "primary" | "meta" | "control" | "alt" | "shift"

const MODIFIER_ALIASES: Record<string, ModifierToken> = {
	cmd: "primary",
	command: "primary",
	meta: "meta",
	super: "meta",
	win: "meta",
	windows: "meta",
	ctrl: "control",
	control: "control",
	alt: "alt",
	option: "alt",
	opt: "alt",
	shift: "shift",
}

/**
 * Map a modifier token to a libnut modifier.
 * - "cmd"/"command" means the platform's primary shortcut key: Command on macOS,
 *   Control elsewhere. Models often write "cmd+c" regardless of OS.
 * - "meta"/"super"/"win" always mean the OS key (Command on macOS, Windows key elsewhere).
 */
function toModifier(token: ModifierToken, platform: string): KeyModifier {
	switch (token) {
		case "primary":
			return platform === "darwin" ? "command" : "control"
		case "meta":
			return "command"
		default:
			return token
	}
}

export function parseKeyCombo(input: string, platform: string = process.platform): ParsedKeyCombo {
	const trimmed = input.trim()
	if (!trimmed) {
		throw new KeyParseError("Key combination is empty.")
	}

	// "+" alone, or a combination ending in "++" (for example "ctrl++"), targets the plus key.
	let parts: string[]
	if (trimmed === "+") {
		parts = ["+"]
	} else if (trimmed.endsWith("++")) {
		parts = [...trimmed.slice(0, -2).split("+"), "+"]
	} else {
		parts = trimmed.split("+")
	}
	parts = parts.map((p) => p.trim())

	if (parts.some((p) => p === "")) {
		throw new KeyParseError(`Invalid key combination "${input}". Use the form "ctrl+shift+t".`)
	}

	const keyToken = parts[parts.length - 1]
	const modifierTokens = parts.slice(0, -1)

	const modifiers: KeyModifier[] = []
	for (const token of modifierTokens) {
		const alias = MODIFIER_ALIASES[token.toLowerCase()]
		if (!alias) {
			throw new KeyParseError(
				`Unknown modifier "${token}" in "${input}". Use cmd, ctrl, alt (option), shift, or win (super).`,
			)
		}
		const modifier = toModifier(alias, platform)
		if (!modifiers.includes(modifier)) {
			modifiers.push(modifier)
		}
	}

	if (MODIFIER_ALIASES[keyToken.toLowerCase()]) {
		throw new KeyParseError(`"${input}" has no main key. Add a key after the modifiers, for example "cmd+c".`)
	}

	return { key: normalizeKey(keyToken, input), modifiers }
}

function normalizeKey(token: string, input: string): string {
	// Single printable character: letters are sent lowercase; use "shift+a" for uppercase.
	if ([...token].length === 1) {
		return token.toLowerCase()
	}

	const lower = token.toLowerCase()
	const resolved = KEY_ALIASES[lower] ?? lower

	if (resolved.length === 1 || NAMED_KEYS.has(resolved)) {
		return resolved
	}

	throw new KeyParseError(
		`Unknown key "${token}" in "${input}". Use a single character or one of: enter, tab, escape, backspace, delete, space, up, down, left, right, home, end, pageup, pagedown, f1-f24.`,
	)
}
