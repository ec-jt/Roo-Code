/**
 * Image generation model constants
 */

/**
 * API method used for image generation
 */
export type ImageGenerationApiMethod = "chat_completions" | "images_api"

export interface ImageGenerationModel {
	value: string
	label: string
	provider: ImageGenerationProvider
	apiMethod?: ImageGenerationApiMethod
}

const titleCase = (value: string) =>
	value
		.split(/[-_/]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ")

export const LITELLM_IMAGE_GENERATION_PREFIXES = ["sd/", "image/"] as const
export const LITELLM_VIDEO_GENERATION_PREFIXES = ["video/"] as const

const LITELLM_IMAGE_GENERATION_FALLBACK_PATTERNS = [/^flux[-/]/i, /^flux$/i, /^heartmula$/i] as const
const LITELLM_VIDEO_GENERATION_FALLBACK_PATTERNS = [/^ltx[-/]/i] as const

export function isLiteLlmImageGenerationModelId(modelId: string | undefined): modelId is string {
	if (!modelId) {
		return false
	}

	return (
		LITELLM_IMAGE_GENERATION_PREFIXES.some((prefix) => modelId.startsWith(prefix)) ||
		LITELLM_IMAGE_GENERATION_FALLBACK_PATTERNS.some((pattern) => pattern.test(modelId))
	)
}

export function isLiteLlmVideoGenerationModelId(modelId: string | undefined): modelId is string {
	if (!modelId) {
		return false
	}

	return (
		LITELLM_VIDEO_GENERATION_PREFIXES.some((prefix) => modelId.startsWith(prefix)) ||
		LITELLM_VIDEO_GENERATION_FALLBACK_PATTERNS.some((pattern) => pattern.test(modelId))
	)
}

export function getLiteLlmImageGenerationModelLabel(modelId: string): string {
	const normalized = modelId.replace(/^(sd|image|video)\//i, "")
	return titleCase(normalized)
}

export const IMAGE_GENERATION_MODELS: ImageGenerationModel[] = [
	// OpenRouter models
	{ value: "google/gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", provider: "openrouter" },
	{ value: "google/gemini-3-pro-image-preview", label: "Gemini 3 Pro Image Preview", provider: "openrouter" },
	{ value: "openai/gpt-5-image", label: "GPT-5 Image", provider: "openrouter" },
	{ value: "openai/gpt-5-image-mini", label: "GPT-5 Image Mini", provider: "openrouter" },
	{ value: "black-forest-labs/flux.2-flex", label: "Black Forest Labs FLUX.2 Flex", provider: "openrouter" },
	{ value: "black-forest-labs/flux.2-pro", label: "Black Forest Labs FLUX.2 Pro", provider: "openrouter" },
	// LiteLLM media models are discovered dynamically from the configured instance.
]

/**
 * Get array of model values only (for backend validation)
 */
export const IMAGE_GENERATION_MODEL_IDS = IMAGE_GENERATION_MODELS.map((m) => m.value)

/**
 * Image generation provider type
 */
export type ImageGenerationProvider = "openrouter" | "litellm"

/**
 * Get the image generation provider with backwards compatibility
 * - If provider is explicitly set, use it
 * - If a model is already configured (existing users), default to "openrouter"
 * - Otherwise default to "openrouter" (new users)
 */
export function getImageGenerationProvider(
	explicitProvider: ImageGenerationProvider | undefined,
	hasExistingModel: boolean,
): ImageGenerationProvider {
	if (explicitProvider !== undefined) {
		return explicitProvider
	}

	return hasExistingModel ? "openrouter" : "openrouter"
}
