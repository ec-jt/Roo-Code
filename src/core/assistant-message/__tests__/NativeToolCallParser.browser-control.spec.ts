import { NativeToolCallParser } from "../NativeToolCallParser"
import { browserControlJsonSchema } from "../../prompts/tools/native-tools/browser-control-schema"
import { supportedBrowserControls } from "../../tools/browserControlCommand"

describe("browser control native arguments", () => {
	it.each([{ action: "status" }, JSON.stringify({ action: "status" })])(
		"parses object and JSON-string commands",
		(command) => {
			const result = NativeToolCallParser.parseToolCall({
				id: "call",
				name: "browser_action",
				arguments: JSON.stringify({ action: "control", command }),
			})
			expect(result?.type === "tool_use" && result.nativeArgs).toMatchObject({
				action: "control",
				command: { action: "status" },
			})
		},
	)
	it.each([
		{ action: "status", approved: true },
		{ action: "debugger", sessionId: "s", tabId: "t" },
		{ action: "fill_ref", text: "secret" },
	])("rejects malformed commands before dispatch", (command) => {
		const result = NativeToolCallParser.parseToolCall({
			id: "call",
			name: "browser_action",
			arguments: JSON.stringify({ action: "control", command }),
		})
		expect(result).toBeNull()
	})
	it("documents every usable command without exposing unsupported capabilities", () => {
		expect(browserControlJsonSchema.anyOf.map((schema) => schema.properties.action.enum[0])).toEqual([
			...supportedBrowserControls,
		])
		for (const schema of browserControlJsonSchema.anyOf) expect(schema.additionalProperties).toBe(false)
	})
})
