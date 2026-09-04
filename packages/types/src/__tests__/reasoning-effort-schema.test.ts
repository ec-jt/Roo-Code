import {
	modelInfoSchema,
	reasoningEffortsExtended,
	reasoningEffortSettingValues,
	type ModelInfo,
} from "../model.js"

describe("reasoning effort schema", () => {
	it("includes max in the extended reasoning efforts", () => {
		expect(reasoningEffortsExtended).toContain("max")
	})

	it("includes max in the reasoning effort user setting values", () => {
		expect(reasoningEffortSettingValues).toContain("max")
	})

	it("accepts max as a supported reasoning effort level in model info", () => {
		const info: ModelInfo = {
			maxTokens: 128000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
			reasoningEffort: "high",
		}

		const result = modelInfoSchema.safeParse(info)
		expect(result.success).toBe(true)
	})

	it("accepts max as the default reasoning effort in model info", () => {
		const info = {
			contextWindow: 1_000_000,
			supportsPromptCache: true,
			reasoningEffort: "max",
		}

		const result = modelInfoSchema.safeParse(info)
		expect(result.success).toBe(true)
	})
})
