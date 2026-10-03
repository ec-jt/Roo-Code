// npx vitest run api/transform/__tests__/mistral-format.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"
import { assistantMessageToJSON } from "@mistralai/mistralai/models/components/assistantmessage"
import { toolMessageToJSON } from "@mistralai/mistralai/models/components/toolmessage"

import { convertToMistralMessages, normalizeMistralToolCallId } from "../mistral-format"

describe("normalizeMistralToolCallId", () => {
	it.each([
		["call_5019f900a247472bacde0b82", "vjuc54vf1"],
		["toolu_01234567890abcdef", "rfuunh5el"],
		["abc", "m3vt5as31"],
		["tool-1", "yethm7ltb"],
		["", "ixqqhkd3p"],
		["---___---", "iifa9x6ig"],
		["a-b_c.d@e", "2z3gkdexy"],
	])("should hash the entire invalid ID %j deterministically", (id, expected) => {
		expect(normalizeMistralToolCallId(id)).toBe(expected)
		expect(normalizeMistralToolCallId(id)).toMatch(/^[a-zA-Z0-9]{9}$/)
	})

	it("should handle IDs that are exactly 9 alphanumeric characters", () => {
		expect(normalizeMistralToolCallId("abcd12345")).toBe("abcd12345")
		expect(normalizeMistralToolCallId("AbC012xY9")).toBe("AbC012xY9")
	})

	it("should return consistent results for the same input", () => {
		const id = "call_5019f900a247472bacde0b82"
		expect(normalizeMistralToolCallId(id)).toBe(normalizeMistralToolCallId(id))
	})

	it.each([
		["call_12345_first", "call_12345_second"],
		["toolu_012345_first", "toolu_012345_second"],
		["tool-1", "tool_1"],
		["abc", "abc0"],
		["", "---___---"],
	])(
		"should distinguish IDs previously collapsed by truncation, stripping, or padding: %j and %j",
		(first, second) => {
			expect(normalizeMistralToolCallId(first)).not.toBe(normalizeMistralToolCallId(second))
		},
	)
})

describe("convertToMistralMessages", () => {
	it("should convert simple text messages for user and assistant roles", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: "Hello",
			},
			{
				role: "assistant",
				content: "Hi there!",
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(2)
		expect(mistralMessages[0]).toEqual({
			role: "user",
			content: "Hello",
		})
		expect(mistralMessages[1]).toEqual({
			role: "assistant",
			content: "Hi there!",
		})
	})

	it("should handle user messages with image content", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What is in this image?",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "base64data",
						},
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("user")

		const content = mistralMessages[0].content as Array<{
			type: string
			text?: string
			imageUrl?: { url: string }
		}>

		expect(Array.isArray(content)).toBe(true)
		expect(content).toHaveLength(2)
		expect(content[0]).toEqual({ type: "text", text: "What is in this image?" })
		expect(content[1]).toEqual({
			type: "image_url",
			imageUrl: { url: "data:image/jpeg;base64,base64data" },
		})
	})

	it("should handle user messages with only tool results", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "weather-123",
						content: "Current temperature in London: 20°C",
					},
				],
			},
		]

		// Tool results are converted to Mistral "tool" role messages
		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("tool")
		expect((mistralMessages[0] as { toolCallId?: string }).toolCallId).toBe(
			normalizeMistralToolCallId("weather-123"),
		)
		expect(mistralMessages[0].content).toBe("Current temperature in London: 20°C")
	})

	it("should handle user messages with mixed content (text, image, and tool results)", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Here's the weather data and an image:",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: "imagedata123",
						},
					},
					{
						type: "tool_result",
						tool_use_id: "weather-123",
						content: "Current temperature in London: 20°C",
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		// Preserve mixed content on the tool response without an invalid tool -> user transition.
		expect(mistralMessages).toHaveLength(1)

		expect(mistralMessages[0].role).toBe("tool")
		expect((mistralMessages[0] as { toolCallId?: string }).toolCallId).toBe(
			normalizeMistralToolCallId("weather-123"),
		)
		expect(mistralMessages[0].content).toEqual([
			{ type: "text", text: "Current temperature in London: 20°C" },
			{ type: "text", text: "Additional user content:" },
			{ type: "text", text: "Here's the weather data and an image:" },
			{ type: "image_url", imageUrl: { url: "data:image/png;base64,imagedata123" } },
		])
	})

	it.each([
		["empty string", { content: "" }],
		["omitted", {}],
		["empty array", { content: [] }],
	] satisfies [string, Partial<Anthropic.ToolResultBlockParam>][])(
		"should serialize complete parallel pairs with %s results and mixed user content",
		(_label, resultContent) => {
			const ids = ["call_12345_first", "call_12345_second", "AbC012xY9"]
			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Check all three files." },
				{
					role: "assistant",
					content: ids.map((id, index) => ({
						type: "tool_use",
						id,
						name: "read_file",
						input: { path: `file-${index}.txt` },
					})),
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: ids[0], ...resultContent },
						{ type: "text", text: "Keep this instruction." },
						{ type: "tool_result", tool_use_id: ids[1], content: "second result" },
						{ type: "tool_result", tool_use_id: ids[2], ...resultContent },
						{ type: "text", text: "And this instruction." },
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: "image-data" },
						},
					],
				},
			]
			const converted = convertToMistralMessages(messages)
			const payload = converted.map((message) => {
				if (message.role === "assistant") return JSON.parse(assistantMessageToJSON(message))
				if (message.role === "tool") return JSON.parse(toolMessageToJSON(message))
				return message
			})
			const normalizedIds = ["i578cc36f", "vvd2afdww", "AbC012xY9"]

			expect(payload).toEqual([
				{ role: "user", content: "Check all three files." },
				{
					role: "assistant",
					prefix: false,
					tool_calls: normalizedIds.map((id, index) => ({
						id,
						index: 0,
						type: "function",
						function: { name: "read_file", arguments: JSON.stringify({ path: `file-${index}.txt` }) },
					})),
				},
				{ role: "tool", tool_call_id: normalizedIds[0], content: "" },
				{ role: "tool", tool_call_id: normalizedIds[1], content: "second result" },
				{
					role: "tool",
					tool_call_id: normalizedIds[2],
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "Additional user content:" },
						{ type: "text", text: "Keep this instruction." },
						{ type: "text", text: "And this instruction." },
						{ type: "image_url", image_url: { url: "data:image/png;base64,image-data" } },
					],
				},
			])
			expect(convertToMistralMessages(messages)).toEqual(converted)
		},
	)

	it("should handle assistant messages with text content", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "I'll help you with that question.",
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("assistant")
		expect(mistralMessages[0].content).toBe("I'll help you with that question.")
	})

	it("should handle assistant messages with tool use", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "Let me check the weather for you.",
					},
					{
						type: "tool_use",
						id: "weather-123",
						name: "get_weather",
						input: { city: "London" },
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("assistant")
		expect(mistralMessages[0].content).toBe("Let me check the weather for you.")
	})

	it("should handle multiple text blocks in assistant messages", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "First paragraph of information.",
					},
					{
						type: "text",
						text: "Second paragraph with more details.",
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("assistant")
		expect(mistralMessages[0].content).toBe("First paragraph of information.\nSecond paragraph with more details.")
	})

	it("should handle a conversation with mixed message types", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What's in this image?",
					},
					{
						type: "image",
						source: {
							type: "base64",
							media_type: "image/jpeg",
							data: "imagedata",
						},
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "text",
						text: "This image shows a landscape with mountains.",
					},
					{
						type: "tool_use",
						id: "search-123",
						name: "search_info",
						input: { query: "mountain types" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "search-123",
						content: "Found information about different mountain types.",
					},
				],
			},
			{
				role: "assistant",
				content: "Based on the search results, I can tell you more about the mountains in the image.",
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		// Tool results are now converted to tool messages
		expect(mistralMessages).toHaveLength(4)

		// User message with image
		expect(mistralMessages[0].role).toBe("user")
		const userContent = mistralMessages[0].content as Array<{
			type: string
			text?: string
			imageUrl?: { url: string }
		}>
		expect(Array.isArray(userContent)).toBe(true)
		expect(userContent).toHaveLength(2)

		// Assistant message with text and toolCalls
		expect(mistralMessages[1].role).toBe("assistant")
		expect(mistralMessages[1].content).toBe("This image shows a landscape with mountains.")

		// Tool result message
		expect(mistralMessages[2].role).toBe("tool")
		expect((mistralMessages[2] as { toolCallId?: string }).toolCallId).toBe(
			normalizeMistralToolCallId("search-123"),
		)
		expect(mistralMessages[2].content).toBe("Found information about different mountain types.")

		// Final assistant message
		expect(mistralMessages[3]).toEqual({
			role: "assistant",
			content: "Based on the search results, I can tell you more about the mountains in the image.",
		})
	})

	it("should handle empty content in assistant messages", () => {
		const anthropicMessages: Anthropic.Messages.MessageParam[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "search-123",
						name: "search_info",
						input: { query: "test query" },
					},
				],
			},
		]

		const mistralMessages = convertToMistralMessages(anthropicMessages)
		expect(mistralMessages).toHaveLength(1)
		expect(mistralMessages[0].role).toBe("assistant")
		expect(mistralMessages[0].content).toBeUndefined()
	})
})
