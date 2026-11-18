// npx vitest run core/assistant-message/__tests__/NativeToolCallParser.computerAction.spec.ts

import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser - computer_action", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	it("parses all computer_action params into nativeArgs", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "toolu_ca_1",
			name: "computer_action" as const,
			arguments: JSON.stringify({
				action: "drag",
				coordinate: "10,20",
				end_coordinate: "30,40",
				text: "hello",
				key: "cmd+c",
				direction: "down",
				amount: "3",
				window: "Notes",
				duration: "500",
			}),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			expect(result.name).toBe("computer_action")
			expect(result.nativeArgs).toEqual({
				action: "drag",
				coordinate: "10,20",
				end_coordinate: "30,40",
				text: "hello",
				key: "cmd+c",
				direction: "down",
				amount: "3",
				window: "Notes",
				duration: "500",
			})
		}
	})

	it("keeps null optional params as given (the tool handler strips them)", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "toolu_ca_2",
			name: "computer_action" as const,
			arguments: JSON.stringify({ action: "screenshot", coordinate: null, text: null }),
		})

		expect(result?.type).toBe("tool_use")
		if (result?.type === "tool_use") {
			const args = result.nativeArgs as unknown as Record<string, unknown>
			expect(args.action).toBe("screenshot")
			expect(args.coordinate).toBeNull()
		}
	})

	it("does not produce nativeArgs when action is missing", () => {
		const result = NativeToolCallParser.parseToolCall({
			id: "toolu_ca_3",
			name: "computer_action" as const,
			arguments: JSON.stringify({ coordinate: "1,1" }),
		})

		// Without an action the call cannot be executed; the parser must not invent one.
		// It either rejects the call (null) or returns a tool_use without nativeArgs.
		const nativeArgs = result?.type === "tool_use" ? result.nativeArgs : undefined
		expect(result === null || result?.type === "tool_use").toBe(true)
		expect(nativeArgs).toBeUndefined()
	})

	it("emits partial nativeArgs while streaming and complete args on finalize", () => {
		const id = "toolu_ca_stream"
		NativeToolCallParser.startStreamingToolCall(id, "computer_action")

		const partial = NativeToolCallParser.processStreamingChunk(id, '{"action":"click","coordinate":"5,')
		expect((partial?.nativeArgs as { action?: string } | undefined)?.action).toBe("click")

		NativeToolCallParser.processStreamingChunk(id, '6"}')
		const final = NativeToolCallParser.finalizeStreamingToolCall(id)

		expect(final?.type).toBe("tool_use")
		if (final?.type === "tool_use") {
			expect(final.nativeArgs).toMatchObject({ action: "click", coordinate: "5,6" })
		}
	})
})
