import { OpenAiHandler } from "../openai"
import { LiteLLMHandler } from "../lite-llm"
import { openAiModelInfoSaneDefaults } from "@roo-code/types"
import { getReasoningDelta } from "../utils/reasoning-delta"

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("openai", () => ({
	default: class {
		chat = { completions: { create } }
	},
}))
vi.mock("../utils/timeout-config", () => ({ getApiRequestTimeout: () => 0 }))
vi.mock("../utils/sdk-timeout", () => ({ configureApiRequestTimeout: (client: unknown) => client }))
vi.mock("../fetchers/modelCache", () => ({ getModels: vi.fn(), getModelsFromCache: vi.fn() }))

function setup(provider: string, chunks: unknown[]) {
	const stream = {
		async *[Symbol.asyncIterator]() {
			yield* chunks
		},
	}
	create.mockReturnValue(
		Object.assign(Promise.resolve(stream), {
			withResponse: async () => ({ data: stream }),
		}),
	)
	if (provider === "litellm") {
		const handler = new LiteLLMHandler({ litellmModelId: "test-reasoner" })
		vi.spyOn(handler, "fetchModel").mockResolvedValue({ id: "test-reasoner", info: openAiModelInfoSaneDefaults })
		return handler
	}
	return new OpenAiHandler({ openAiModelId: provider === "openai-o3" ? "o3" : "test-reasoner" })
}

describe.each(["litellm", "openai", "openai-o3"])("%s reasoning deltas", (provider) => {
	beforeEach(() => create.mockReset())
	it.each(["reasoning_content", "reasoning"])("forwards %s before waiting for subsequent text", async (field) => {
		const handler = setup(provider, [
			{ choices: [{ delta: { [field]: "Thinking" } }] },
			{ choices: [{ delta: { content: "Answer" } }] },
		])
		const iterator = handler.createMessage("system", [])
		expect(await iterator.next()).toEqual({ done: false, value: { type: "reasoning", text: "Thinking" } })
		const remaining = []
		for await (const chunk of iterator) remaining.push(chunk)
		expect(remaining).toContainEqual({ type: "text", text: "Answer" })
	})
	it("preserves native tool-call arguments and usage alongside reasoning", async () => {
		const handler = setup(provider, [
			{
				choices: [
					{
						delta: {
							reasoning: "Plan",
							tool_calls: [
								{
									index: 0,
									id: "call_a",
									type: "function",
									function: { name: "emit_result", arguments: '{"result":' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						delta: { tool_calls: [{ index: 0, function: { arguments: '"OK"}' } }] },
						finish_reason: "tool_calls",
					},
				],
			},
			{ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		])
		const output = []
		for await (const chunk of handler.createMessage("system", [])) output.push(chunk)
		expect(output[0]).toEqual({ type: "reasoning", text: "Plan" })
		expect(
			output
				.filter((chunk) => chunk.type === "tool_call_partial")
				.map((chunk) => chunk.arguments ?? "")
				.join(""),
		).toBe('{"result":"OK"}')
		expect(output).toContainEqual(expect.objectContaining({ type: "usage", inputTokens: 10, outputTokens: 5 }))
	})
	it("does not duplicate aliases or turn reasoning-only output into an answer", async () => {
		const handler = setup(provider, [
			{ choices: [{ delta: { reasoning_content: "Thinking", reasoning: "Thinking" } }] },
			{ choices: [{ delta: {}, finish_reason: "length" }] },
		])
		const output = []
		for await (const chunk of handler.createMessage("system", [])) output.push(chunk)
		expect(output).toEqual([{ type: "reasoning", text: "Thinking" }])
	})
})

it.each([
	[undefined, undefined],
	[{ reasoning_content: "old", reasoning: "new" }, "old"],
	[{ reasoning_content: "", reasoning: "fallback" }, "fallback"],
	[{ reasoning_content: { text: "opaque" }, reasoning: "fallback" }, "fallback"],
	[{ reasoning: ["not plain text"] }, undefined],
	[{ reasoning: true }, undefined],
	[{ reasoning: " " }, " "],
])("normalizes only plain-text reasoning (%j)", (delta, expected) => {
	expect(getReasoningDelta(delta)).toBe(expected)
})
