import { anthropicDefaultModelId, anthropicModels } from "../providers/anthropic.js"

describe("anthropic provider models", () => {
	it("uses claude-sonnet-5 as the default model", () => {
		expect(anthropicDefaultModelId).toBe("claude-sonnet-5")
	})

	it("includes claude-sonnet-5 with expected core capabilities", () => {
		const model = anthropicModels["claude-sonnet-5"]

		expect(model).toBeDefined()
		expect(model.contextWindow).toBe(1_000_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsTemperature).toBe(false)
		expect(model.inputPrice).toBe(3)
		expect(model.outputPrice).toBe(15)
		expect(model.supportsReasoningEffort).toEqual(["disable", "low", "medium", "high"])
		expect(model.requiredReasoningEffort).toBe(true)
		expect(model.reasoningEffort).toBe("high")
	})
})
