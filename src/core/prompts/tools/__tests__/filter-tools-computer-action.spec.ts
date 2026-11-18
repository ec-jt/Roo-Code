import type OpenAI from "openai"

import { filterNativeToolsForMode, isToolAllowedInMode } from "../filter-tools-for-mode"
import computerAction from "../native-tools/computer_action"

function names(tools: OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools.map((t) => (t as { function: { name: string } }).function.name)
}

const readFile = {
	type: "function",
	function: { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
} satisfies OpenAI.Chat.ChatCompletionTool

describe("computer_action tool filtering", () => {
	const nativeTools = [readFile, computerAction] as OpenAI.Chat.ChatCompletionTool[]

	it("hides computer_action by default (setting absent)", () => {
		expect(names(filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {}))).not.toContain(
			"computer_action",
		)
	})

	it("hides computer_action when computerUseEnabled is false", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			computerUseEnabled: false,
		})
		expect(names(result)).not.toContain("computer_action")
	})

	it("shows computer_action in code mode when computerUseEnabled is true", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			computerUseEnabled: true,
		})
		expect(names(result)).toContain("computer_action")
	})

	it.each(["architect", "ask", "debug", "orchestrator"])("shows computer_action in %s mode when enabled", (mode) => {
		const result = filterNativeToolsForMode(nativeTools, mode, undefined, undefined, undefined, {
			computerUseEnabled: true,
		})
		expect(names(result)).toContain("computer_action")
	})

	it.each(["architect", "ask", "debug", "orchestrator"])("hides computer_action in %s mode when disabled", (mode) => {
		const result = filterNativeToolsForMode(nativeTools, mode, undefined, undefined, undefined, {
			computerUseEnabled: false,
		})
		expect(names(result)).not.toContain("computer_action")
	})

	it("shows computer_action in a custom mode without the computer group when enabled", () => {
		const customModes = [{ slug: "reader", name: "Reader", roleDefinition: "Reads", groups: ["read" as const] }]
		const result = filterNativeToolsForMode(nativeTools, "reader", customModes, undefined, undefined, {
			computerUseEnabled: true,
		})
		expect(names(result)).toContain("computer_action")
		expect(isToolAllowedInMode("computer_action", "reader", customModes, undefined, undefined, {})).toBe(false)
		expect(
			isToolAllowedInMode("computer_action", "reader", customModes, undefined, undefined, {
				computerUseEnabled: true,
			}),
		).toBe(true)
	})

	it("respects disabledTools", () => {
		const result = filterNativeToolsForMode(nativeTools, "code", undefined, undefined, undefined, {
			computerUseEnabled: true,
			disabledTools: ["computer_action"],
		})
		expect(names(result)).not.toContain("computer_action")
	})

	it("isToolAllowedInMode requires the setting", () => {
		expect(isToolAllowedInMode("computer_action", "code", undefined, undefined, undefined, {})).toBe(false)
		expect(
			isToolAllowedInMode("computer_action", "code", undefined, undefined, undefined, {
				computerUseEnabled: true,
			}),
		).toBe(true)
	})
})
