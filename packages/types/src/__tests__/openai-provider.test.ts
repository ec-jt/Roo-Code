import { openAiNativeDefaultModelId, openAiNativeModels } from "../providers/openai.js"

describe("openai provider models", () => {
	it("keeps gpt-5.6-sol as the default model", () => {
		expect(openAiNativeDefaultModelId).toBe("gpt-5.6-sol")
	})

	it("includes gpt-6-astra with expected capabilities from the official docs", () => {
		const model = openAiNativeModels["gpt-6-astra"]

		expect(model).toBeDefined()
		expect(model.contextWindow).toBe(1_050_000)
		expect(model.maxTokens).toBe(128000)
		expect(model.supportsImages).toBe(true)
		expect(model.supportsPromptCache).toBe(true)
		expect(model.supportsTemperature).toBe(false)
		expect(model.supportsVerbosity).toBe(true)
		// $10 / $1 cached / $12.50 cache write / $50 per MTok
		expect(model.inputPrice).toBe(10)
		expect(model.outputPrice).toBe(50)
		expect(model.cacheReadsPrice).toBe(1)
		expect(model.cacheWritesPrice).toBe(12.5)
		// reasoning.effort supports low, medium, high, xhigh, and max
		expect(model.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
		expect(model.reasoningEffort).toBe("high")
		// Prompts over 272K input tokens: 2x input and cache rates, 1.5x output
		expect(model.longContextPricing).toEqual({
			thresholdTokens: 272_000,
			inputPriceMultiplier: 2,
			outputPriceMultiplier: 1.5,
			cacheWritesPriceMultiplier: 2,
			cacheReadsPriceMultiplier: 2,
			appliesToServiceTiers: ["default", "flex"],
		})
		// Batch and Flex are priced at 50% of Standard rates
		expect(model.tiers).toEqual([
			{
				name: "flex",
				contextWindow: 1_050_000,
				inputPrice: 5.0,
				outputPrice: 25.0,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
			},
		])
	})
})
