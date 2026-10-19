import axios from "axios"

import type { ModelRecord } from "@roo-code/types"

import { DEFAULT_HEADERS } from "../constants"

const DISCOVERY_TIMEOUT_MS = 5000
const DISCOVERY_MAX_BYTES = 5 * 1024 * 1024
const DISCOVERY_GUIDANCE = "Check the base URL and API key; the proxy must expose /v1/model/info."

/** Fetch a fresh catalog. Never log transport errors or response bodies, which can contain secrets. */
export async function getLiteLLMModels(apiKey: string, baseUrl: string): Promise<ModelRecord> {
	let url: URL
	try {
		url = new URL(baseUrl.trim())
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
			throw new Error("Invalid discovery URL")
		}
		url.pathname = url.pathname.replace(/\/+/g, "/").replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/model/info"
		url.search = ""
		url.hash = ""
	} catch {
		throw new Error("Failed to fetch LiteLLM models: Use an HTTP(S) base URL without embedded credentials.")
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...DEFAULT_HEADERS,
	}
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`

	let data: unknown
	try {
		const response = await axios.get(url.href, {
			headers,
			timeout: DISCOVERY_TIMEOUT_MS,
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
			maxRedirects: 0,
			maxContentLength: DISCOVERY_MAX_BYTES,
		})
		data = response.data
	} catch (error) {
		if (axios.isAxiosError(error)) {
			const status = error.response?.status
			if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
				const reason =
					status >= 300 && status < 400
						? "Redirects are not followed; use the proxy's final base URL."
						: status === 401 || status === 403
							? "The API key must have access to model discovery."
							: DISCOVERY_GUIDANCE
				throw new Error(`Failed to fetch LiteLLM models: HTTP ${status}. ${reason}`)
			}
			if (["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(error.code ?? "")) {
				throw new Error(
					`Failed to fetch LiteLLM models: Request timed out after 5 seconds. ${DISCOVERY_GUIDANCE}`,
				)
			}
		}
		throw new Error(`Failed to fetch LiteLLM models: Request failed. ${DISCOVERY_GUIDANCE}`)
	}

	if (!data || typeof data !== "object" || !("data" in data) || !Array.isArray(data.data)) {
		throw new Error(`Failed to fetch LiteLLM models: Unexpected response format. ${DISCOVERY_GUIDANCE}`)
	}

	const models: ModelRecord = {}
	for (const model of data.data) {
		const modelName = model?.model_name
		const modelInfo = model?.model_info
		// Some proxies redact litellm_params. Discovery only needs the public alias and metadata.
		if (typeof modelName !== "string" || !modelName.trim() || !modelInfo || typeof modelInfo !== "object") {
			continue
		}

		Object.defineProperty(models, modelName, {
			enumerable: true,
			configurable: true,
			writable: true,
			value: {
				maxTokens: modelInfo.max_output_tokens || modelInfo.max_tokens || 8192,
				contextWindow: modelInfo.max_input_tokens || 200000,
				supportsImages: Boolean(modelInfo.supports_vision),
				supportsPromptCache: Boolean(modelInfo.supports_prompt_caching),
				inputPrice: modelInfo.input_cost_per_token ? modelInfo.input_cost_per_token * 1000000 : undefined,
				outputPrice: modelInfo.output_cost_per_token ? modelInfo.output_cost_per_token * 1000000 : undefined,
				cacheWritesPrice: modelInfo.cache_creation_input_token_cost
					? modelInfo.cache_creation_input_token_cost * 1000000
					: undefined,
				cacheReadsPrice: modelInfo.cache_read_input_token_cost
					? modelInfo.cache_read_input_token_cost * 1000000
					: undefined,
				description: `${modelName} via LiteLLM proxy`,
			},
		})
	}
	return models
}
