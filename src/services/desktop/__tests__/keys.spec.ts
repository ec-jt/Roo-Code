import { KeyParseError, parseKeyCombo } from "../keys"

describe("parseKeyCombo", () => {
	it.each([
		["enter", "darwin", { key: "enter", modifiers: [] }],
		["Return", "linux", { key: "enter", modifiers: [] }],
		["esc", "win32", { key: "escape", modifiers: [] }],
		["F5", "win32", { key: "f5", modifiers: [] }],
		["A", "linux", { key: "a", modifiers: [] }],
		["shift+a", "linux", { key: "a", modifiers: ["shift"] }],
		["ctrl+shift+t", "linux", { key: "t", modifiers: ["control", "shift"] }],
		["option+left", "darwin", { key: "left", modifiers: ["alt"] }],
		["ArrowDown", "darwin", { key: "down", modifiers: [] }],
		[" cmd + c ", "darwin", { key: "c", modifiers: ["command"] }],
		["ctrl++", "win32", { key: "+", modifiers: ["control"] }],
		["+", "linux", { key: "+", modifiers: [] }],
		["ctrl+plus", "linux", { key: "+", modifiers: ["control"] }],
		["ctrl+control+c", "linux", { key: "c", modifiers: ["control"] }],
	])("%s on %s", (input, platform, expected) => {
		expect(parseKeyCombo(input, platform)).toEqual(expected)
	})

	it("maps cmd to the primary shortcut key per platform", () => {
		expect(parseKeyCombo("cmd+v", "darwin").modifiers).toEqual(["command"])
		expect(parseKeyCombo("cmd+v", "win32").modifiers).toEqual(["control"])
		expect(parseKeyCombo("cmd+v", "linux").modifiers).toEqual(["control"])
	})

	it("maps win/super/meta to the OS key on every platform", () => {
		expect(parseKeyCombo("win+r", "win32").modifiers).toEqual(["command"])
		expect(parseKeyCombo("super+a", "linux").modifiers).toEqual(["command"])
		expect(parseKeyCombo("meta+space", "darwin")).toEqual({ key: "space", modifiers: ["command"] })
	})

	it.each([
		["", /empty/],
		["ctrl+", /Invalid key combination/],
		["ctrl+shift", /no main key/],
		["hyper+a", /Unknown modifier "hyper"/],
		["ctrl+banana", /Unknown key "banana"/],
		["f25", /Unknown key/],
	])("rejects %j", (input, message) => {
		expect(() => parseKeyCombo(input, "linux")).toThrow(KeyParseError)
		expect(() => parseKeyCombo(input, "linux")).toThrow(message)
	})
})
