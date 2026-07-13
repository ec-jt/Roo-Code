import {
	getImageGenerationProvider,
	getLiteLlmImageGenerationModelLabel,
	isLiteLlmImageGenerationModelId,
	isLiteLlmVideoGenerationModelId,
} from "../image-generation.js"

describe("image generation helpers", () => {
	it("supports the litellm image-generation provider", () => {
		expect(getImageGenerationProvider("litellm", false)).toBe("litellm")
	})

	it("recognizes LiteLLM image models by prefix", () => {
		expect(isLiteLlmImageGenerationModelId("sd/my-model")).toBe(true)
		expect(isLiteLlmImageGenerationModelId("image/demo-model")).toBe(true)
	})

	it("recognizes current Flux-style LiteLLM image models", () => {
		expect(isLiteLlmImageGenerationModelId("flux-krea-dev")).toBe(true)
		expect(isLiteLlmImageGenerationModelId("flux-redux-dev")).toBe(true)
		expect(isLiteLlmImageGenerationModelId("heartmula")).toBe(true)
	})

	it("recognizes LiteLLM video models separately", () => {
		expect(isLiteLlmVideoGenerationModelId("video/demo-model")).toBe(true)
		expect(isLiteLlmVideoGenerationModelId("ltx-video")).toBe(true)
		expect(isLiteLlmVideoGenerationModelId("flux-krea-dev")).toBe(false)
	})

	it("builds readable labels for prefixed LiteLLM image models", () => {
		expect(getLiteLlmImageGenerationModelLabel("image/flux-kontext-dev")).toBe("Flux Kontext Dev")
		expect(getLiteLlmImageGenerationModelLabel("sd/sd-xl")).toBe("Sd Xl")
	})
})
