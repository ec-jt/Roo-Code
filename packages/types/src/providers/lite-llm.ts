import type { ModelInfo } from "../model.js"

// https://docs.litellm.ai/
// Proxy aliases are deployment-specific. Require an explicit selection after discovery.
export const litellmDefaultModelId = ""

export const litellmDefaultModelInfo: ModelInfo = {
	maxTokens: 8192,
	contextWindow: 200_000,
	supportsImages: true,
	supportsPromptCache: true,
	inputPrice: 3.0,
	outputPrice: 15.0,
	cacheWritesPrice: 3.75,
	cacheReadsPrice: 0.3,
}
