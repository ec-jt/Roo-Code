import type { ModelInfo } from "../model.js"

// https://platform.deepseek.com/docs/api
// preserveReasoning enables interleaved thinking mode for tool calls:
// DeepSeek requires reasoning_content to be passed back during tool call
// continuation within the same turn. See: https://api-docs.deepseek.com/guides/thinking_mode
export type DeepSeekModelId = keyof typeof deepSeekModels

export const deepSeekDefaultModelId: DeepSeekModelId = "deepseek-flash"

export const deepSeekModels = {
	// Canonical ID for DeepSeek V4.1-Flash (native multimodal). V4-Flash and
	// V4-Flash-Vision-Exp are retired; the v4-flash IDs temporarily route here.
	"deepseek-flash": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: true, // V4.1-Flash has native multimodal (vision) support
		supportsPromptCache: true,
		preserveReasoning: true,
		// Peak rates (DeepSeek bills peak/off-peak); off-peak is half.
		inputPrice: 0.3, // cache miss
		outputPrice: 1.2,
		cacheWritesPrice: 0.3, // cache miss
		cacheReadsPrice: 0.006, // cache hit
		description:
			"DeepSeek V4.1-Flash is the current flagship model: fast, cost-efficient, natively multimodal, with a 1M context window and strong tool-use capabilities.",
	},
	// Forward-compatible ID for DeepSeek V4.1-Pro. Not yet live on the API; it
	// will become the pro-tier model once V4.1-Pro launches (V4-Pro is being
	// phased out and routes to V4.1-Flash from 2026-09-14 until then).
	"deepseek-pro": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false, // V4-Pro has no vision; V4.1-Pro parity until launch
		supportsPromptCache: true,
		preserveReasoning: true,
		// Peak rates (DeepSeek bills peak/off-peak); off-peak is half.
		inputPrice: 1.32, // cache miss
		outputPrice: 3.96,
		cacheWritesPrice: 1.32, // cache miss
		cacheReadsPrice: 0.044, // cache hit
		description:
			"DeepSeek V4.1-Pro (upcoming). The pro-tier successor to V4-Pro with a 1M context window, advanced structured output, and agentic performance.",
	},
	// Retired: V4-Flash temporarily routes to V4.1-Flash.
	"deepseek-v4-flash": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0, // all input is either a cache hit or miss
		outputPrice: 0.28,
		cacheWritesPrice: 0.14,
		cacheReadsPrice: 0.0028,
		description:
			"DeepSeek V4 Flash is a fast, cost-efficient reasoning model with a 1M context window and strong tool-use capabilities.",
	},
	"deepseek-v4-pro": {
		maxTokens: 384_000,
		contextWindow: 1_000_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0, // all input is either a cache hit or miss
		outputPrice: 0.87,
		cacheWritesPrice: 0.435,
		cacheReadsPrice: 0.003625,
		description:
			"DeepSeek V4 Pro is a flagship reasoning model with a 1M context window, advanced structured output, and agentic performance.",
	},
	// Legacy aliases (discontinued 2026-07-24): point at V4.1-Flash behavior.
	"deepseek-chat": {
		maxTokens: 8192, // 8K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		inputPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		outputPrice: 0.42, // $0.42 per million tokens - Updated Dec 9, 2025
		cacheWritesPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit) - Updated Dec 9, 2025
		description: `DeepSeek-V3.2 (Non-thinking Mode) achieves a significant breakthrough in inference speed over previous models. It tops the leaderboard among open-source models and rivals the most advanced closed-source models globally. Supports JSON output, tool calls, chat prefix completion (beta), and FIM completion (beta).`,
	},
	"deepseek-reasoner": {
		maxTokens: 8192, // 8K max output
		contextWindow: 128_000,
		supportsImages: false,
		supportsPromptCache: true,
		preserveReasoning: true,
		inputPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		outputPrice: 0.42, // $0.42 per million tokens - Updated Dec 9, 2025
		cacheWritesPrice: 0.28, // $0.28 per million tokens (cache miss) - Updated Dec 9, 2025
		cacheReadsPrice: 0.028, // $0.028 per million tokens (cache hit) - Updated Dec 9, 2025
		description: `DeepSeek-V3.2 (Thinking Mode) achieves performance comparable to OpenAI-o1 across math, code, and reasoning tasks. Supports Chain of Thought reasoning with up to 8K output tokens. Supports JSON output, tool calls, and chat prefix completion (beta).`,
	},
} as const satisfies Record<string, ModelInfo>

// https://api-docs.deepseek.com/quick_start/parameter_settings
export const DEEP_SEEK_DEFAULT_TEMPERATURE = 0.3
