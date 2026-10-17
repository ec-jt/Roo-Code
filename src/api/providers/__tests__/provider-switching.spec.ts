import type { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicHandler } from "../anthropic"
import { DeepSeekHandler } from "../deepseek"
import { OpenAiNativeHandler } from "../openai-native"
import { OpenAiCodexHandler } from "../openai-codex"
import { convertToOpenAiMessages } from "../../transform/openai-format"

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
	anthropicCreate: vi.fn(),
	openaiCreate: vi.fn(),
}))
vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn(() => ({ messages: { create: anthropicCreate } })),
}))
vi.mock("openai", () => ({
	default: vi.fn(() => ({ chat: { completions: { create: openaiCreate } } })),
}))

const tools = [
	{ type: "function" as const, function: { name: "read_file", parameters: { type: "object", properties: {} } } },
]
const call = { type: "tool_use", id: "call_shared", name: "read_file", input: { path: "example.txt" } }
function history(source: "anthropic" | "openai" | "deepseek"): Anthropic.Messages.MessageParam[] {
	const reasoning =
		source === "anthropic"
			? [{ type: "thinking", thinking: "native thinking", signature: "claude-signature" }]
			: source === "deepseek"
				? [{ type: "reasoning", text: "native reasoning" }]
				: []
	return [
		{ role: "user", content: "Read the file" },
		...(source === "openai"
			? [{ type: "reasoning", id: "rs_old", encrypted_content: "openai-opaque", summary: [] }]
			: []),
		{ role: "assistant", content: [...reasoning, { type: "text", text: "Reading it" }, call] },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: call.id, content: "file contents" },
				{ type: "text", text: "environment details" },
			],
		},
	] as Anthropic.Messages.MessageParam[]
}
async function consume(stream: AsyncIterable<unknown>) {
	for await (const _chunk of stream) {
		/* consume */
	}
}
const emptyStream = async function* () {}

describe("provider switching request compatibility", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		anthropicCreate.mockResolvedValue(emptyStream())
		openaiCreate.mockResolvedValue(emptyStream())
	})

	it.each(["openai", "deepseek"] as const)("%s to Anthropic keeps tools and adaptive thinking", async (source) => {
		const messages = history(source),
			before = structuredClone(messages)
		const handler = new AnthropicHandler({ apiKey: "test", apiModelId: "claude-sonnet-4-6" })
		await consume(handler.createMessage("system", messages, { taskId: "test", tools }))
		expect(anthropicCreate).toHaveBeenCalledTimes(1)
		const body = anthropicCreate.mock.calls[0][0]
		expect(body.thinking.type).toBe("adaptive")
		expect(body.messages).toHaveLength(3)
		expect(body.messages[1].content).toContainEqual(call)
		expect(body.messages[2].content[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: call.id,
			content: "file contents",
		})
		expect(JSON.stringify(body)).not.toMatch(/openai-opaque|native reasoning|rs_old/)
		expect(messages).toEqual(before)
	})

	it.each(["openai", "deepseek"] as const)(
		"%s to manual-thinking Claude uses a request-only fallback",
		async (source) => {
			const handler = new AnthropicHandler({
				apiKey: "test",
				apiModelId: "claude-3-7-sonnet-20250219:thinking",
				modelMaxThinkingTokens: 2048,
			})
			await consume(handler.createMessage("system", history(source), { taskId: "test", tools }))
			expect(anthropicCreate.mock.calls[0][0].thinking).toBeUndefined()
			expect(anthropicCreate.mock.calls[0][0].messages[1].content).toContainEqual(call)
		},
	)

	it("preserves native Claude signatures and manual thinking", async () => {
		const handler = new AnthropicHandler({
			apiKey: "test",
			apiModelId: "claude-3-7-sonnet-20250219:thinking",
			modelMaxThinkingTokens: 2048,
		})
		await consume(handler.createMessage("system", history("anthropic"), { taskId: "test", tools }))
		const body = anthropicCreate.mock.calls[0][0]
		expect(body.thinking.type).toBe("enabled")
		expect(body.messages[1].content[0]).toEqual({
			type: "thinking",
			thinking: "native thinking",
			signature: "claude-signature",
		})
	})

	it.each(["anthropic", "deepseek"] as const)("%s to OpenAI Responses keeps the call/result pair", async (source) => {
		const messages = history(source),
			before = structuredClone(messages)
		const handler = new OpenAiNativeHandler({ openAiNativeApiKey: "test", apiModelId: "gpt-4.1" })
		let body: any
			vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* (request: any) {
				body = request
				yield { type: "text", text: "mock response" }
			})
		await consume(handler.createMessage("system", messages, { taskId: "test", tools }))
		expect(body.input).toContainEqual({
			type: "function_call",
			call_id: call.id,
			name: call.name,
			arguments: JSON.stringify(call.input),
		})
		expect(body.input).toContainEqual({ type: "function_call_output", call_id: call.id, output: "file contents" })
		expect(body.previous_response_id).toBeUndefined()
		expect(JSON.stringify(body)).not.toMatch(/claude-signature|native thinking|native reasoning/)
		expect(messages).toEqual(before)
	})

	it.each(["anthropic", "openai"] as const)(
		"%s to DeepSeek keeps tools with non-thinking fallback",
		async (source) => {
			const messages = history(source),
				before = structuredClone(messages)
			const handler = new DeepSeekHandler({ deepSeekApiKey: "test", apiModelId: "deepseek-flash" })
			await consume(handler.createMessage("system", messages, { taskId: "test", tools }))
			expect(openaiCreate).toHaveBeenCalledTimes(1)
			const body = openaiCreate.mock.calls[0][0]
			expect(body.thinking).toEqual({ type: "disabled" })
			expect(body.messages[1].tool_calls).toEqual([
				{ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } },
			])
			expect(body.messages[2]).toEqual({
				role: "tool",
				tool_call_id: call.id,
				content: "file contents\n\nenvironment details",
			})
			expect(messages).toEqual(before)
		},
	)

	it.each(["anthropic", "openai", "deepseek"] as const)(
		"%s history also converts to OpenAI Chat Completions and Codex",
		(source) => {
			const messages = history(source)
			const chat = convertToOpenAiMessages(messages)
			expect(chat.find((message) => message.role === "assistant")).toMatchObject({
				tool_calls: [{ id: call.id }],
			})
			expect(chat.find((message) => message.role === "tool")).toMatchObject({
				tool_call_id: call.id,
				content: "file contents",
			})
			const codex = Object.create(OpenAiCodexHandler.prototype)
			const input = codex.formatFullConversation("system", messages)
			expect(input).toContainEqual({ type: "function_call_output", call_id: call.id, output: "file contents" })
			expect(input.some((item: any) => item.type === "function_call" && item.call_id === call.id)).toBe(true)
		},
	)
})
