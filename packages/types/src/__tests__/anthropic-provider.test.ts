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

	it("includes claude-fable-5-1 with expected capabilities", () => {
		const model = anthropicModels["claude-fable-5-1"]

		expect(model).toBeDefined()
		expect(model.contextWindow).toBe(1_000_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsTemperature).toBe(false)
		expect(model.inputPrice).toBe(10)
		expect(model.outputPrice).toBe(50)
		expect(model.cacheWritesPrice).toBe(12.5)
		// Cache reads on Fable 5.1 cost 0.025x base input price
		expect(model.cacheReadsPrice).toBe(0.25)
		expect(model.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
		expect(model.requiredReasoningEffort).toBe(true)
		expect(model.reasoningEffort).toBe("high")
		// Flat pricing across the whole 1M window
		expect("tiers" in model).toBe(false)
		expect("longContextPricing" in model).toBe(false)
	})

	it("includes claude-opus-5 with expected capabilities", () => {
		const model = anthropicModels["claude-opus-5"]

		expect(model).toBeDefined()
		expect(model.contextWindow).toBe(1_000_000)
		expect(model.maxTokens).toBe(128_000)
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsTemperature).toBe(false)
		expect(model.inputPrice).toBe(5)
		expect(model.outputPrice).toBe(25)
		expect(model.cacheWritesPrice).toBe(6.25)
		expect(model.cacheReadsPrice).toBe(0.5)
		expect(model.supportsReasoningEffort).toEqual(["disable", "low", "medium", "high", "xhigh", "max"])
		expect(model.requiredReasoningEffort).toBe(true)
		expect(model.reasoningEffort).toBe("high")
		// 1M is the default and only context window — no tiered pricing
		expect("tiers" in model).toBe(false)
		expect("longContextPricing" in model).toBe(false)
	})
})
