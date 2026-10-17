import { createHash } from "node:crypto"
import axios from "axios"
import { type LLMInfo, type LLMInstanceInfo, LMStudioClient } from "@lmstudio/sdk"

import { type ModelInfo, type ModelRecord, lMStudioDefaultModelInfo } from "@roo-code/types"

import { normalizeLMStudioBaseUrl, safeLMStudioError } from "../utils/lm-studio-config"
import { MODEL_FETCH_TIMEOUT_MS } from "./fetch-timeout"

// Memory-only identity: never retain a token in a cache key or use the provider-wide disk cache.
const modelsWithLoadedDetails = new Map<string, Set<string>>()
const modelCatalogs = new Map<string, ModelRecord>()
const scopeKey = (baseUrl?: string, apiKey?: string) =>
	`${normalizeLMStudioBaseUrl(baseUrl)}:${createHash("sha256")
		.update(apiKey?.trim() || "")
		.digest("hex")}`

export const hasLoadedFullDetails = (modelId: string, baseUrl?: string, apiKey?: string): boolean =>
	modelsWithLoadedDetails.get(scopeKey(baseUrl, apiKey))?.has(modelId) ?? false

export const getCachedLMStudioModels = (baseUrl?: string, apiKey?: string): ModelRecord | undefined =>
	modelCatalogs.get(scopeKey(baseUrl, apiKey))

/** Compatibility entry point. Refresh metadata without loading or changing a model. */
export const forceFullModelDetailsLoad = async (baseUrl: string, _modelId: string, apiKey?: string): Promise<void> => {
	await getLMStudioModels(baseUrl, apiKey)
}

const positiveNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

export const parseLMStudioModel = (rawModel: LLMInstanceInfo | LLMInfo): ModelInfo => {
	const contextLength =
		positiveNumber("contextLength" in rawModel ? rawModel.contextLength : undefined) ??
		positiveNumber(rawModel.maxContextLength) ??
		lMStudioDefaultModelInfo.contextWindow
	return {
		...lMStudioDefaultModelInfo,
		description: `${rawModel.displayName} - ${rawModel.path}`,
		contextWindow: contextLength,
		maxTokens: contextLength,
		supportsImages: rawModel.vision,
	}
}

type JsonObject = Record<string, unknown>
const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}
const nonemptyString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value : undefined

function isAuthError(error: unknown): boolean {
	const status = asObject(asObject(error).response).status
	return status === 401 || status === 403
}

/** The SDK has no cancellation/dispose API. Bound our wait, and consume late rejections. */
async function bounded<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject({ code: "ETIMEDOUT" }), MODEL_FETCH_TIMEOUT_MS)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

function parseNativeModels(data: unknown, loaded: Set<string>): ModelRecord {
	const entries = asObject(data).models
	if (!Array.isArray(entries)) throw new Error("Invalid model list")
	const models = new Map<string, ModelInfo>()
	for (const entry of entries) {
		const model = asObject(entry)
		const key = nonemptyString(model.key)
		if (!key || !nonemptyString(model.type)) throw new Error("Invalid model metadata")
		if (model.type !== "llm") continue
		if (!Array.isArray(model.loaded_instances)) throw new Error("Invalid model instances")
		const contextLength = positiveNumber(model.max_context_length) ?? lMStudioDefaultModelInfo.contextWindow
		const info: ModelInfo = {
			...lMStudioDefaultModelInfo,
			description: `${nonemptyString(model.display_name) ?? key} - ${key}`,
			contextWindow: contextLength,
			maxTokens: contextLength,
			supportsImages: asObject(model.capabilities).vision === true,
		}
		if (model.loaded_instances.length === 0) models.set(key, info)
		for (const instanceValue of model.loaded_instances) {
			const instance = asObject(instanceValue)
			const id = nonemptyString(instance.id)
			if (!id) throw new Error("Invalid model instance identifier")
			const runtimeContext = positiveNumber(asObject(instance.config).context_length)
			models.set(id, {
				...info,
				...(runtimeContext ? { contextWindow: runtimeContext, maxTokens: runtimeContext } : {}),
			})
			if (runtimeContext) loaded.add(id)
		}
	}
	return Object.fromEntries(models)
}

function parseCompatibleModels(data: unknown): Map<string, ModelInfo> {
	const entries = asObject(data).data
	if (!Array.isArray(entries)) throw new Error("Invalid model list")
	const models = new Map<string, ModelInfo>()
	for (const entry of entries) {
		const model = asObject(entry)
		const id = nonemptyString(model.id)
		if (!id) throw new Error("Invalid model identifier")
		if (model.type && model.type !== "llm" && model.type !== "vlm") continue
		models.set(id, { ...lMStudioDefaultModelInfo, description: id })
	}
	return models
}

export async function getLMStudioModels(baseUrl?: string, apiKey?: string): Promise<ModelRecord> {
	const root = normalizeLMStudioBaseUrl(baseUrl)
	const token = apiKey?.trim()
	const scope = scopeKey(root, token)
	modelsWithLoadedDetails.delete(scope)
	modelCatalogs.delete(scope)
	const loaded = new Set<string>()
	const requestOptions = {
		timeout: MODEL_FETCH_TIMEOUT_MS,
		maxRedirects: 0,
		maxContentLength: 10 * 1024 * 1024,
		...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
	}
	const remember = (models: ModelRecord): ModelRecord => {
		// Bound memory growth if a user repeatedly changes server/token settings.
		if (modelsWithLoadedDetails.size >= 100) {
			const oldest = modelsWithLoadedDetails.keys().next().value
			if (oldest !== undefined) {
				modelsWithLoadedDetails.delete(oldest)
				modelCatalogs.delete(oldest)
			}
		}
		modelsWithLoadedDetails.set(scope, loaded)
		modelCatalogs.set(scope, models)
		return models
	}

	// Official native API includes unloaded models, capabilities, and runtime contexts:
	// https://lmstudio.ai/docs/developer/rest/list
	try {
		const response = await axios.get<unknown>(`${root}api/v1/models`, requestOptions)
		return remember(parseNativeModels(response.data, loaded))
	} catch (error) {
		loaded.clear()
		if (isAuthError(error)) throw safeLMStudioError(error)
	}

	let models = new Map<string, ModelInfo>()
	let compatibleSucceeded = false
	let compatibleError: unknown
	try {
		const response = await axios.get<unknown>(`${root}v1/models`, requestOptions)
		models = parseCompatibleModels(response.data)
		compatibleSucceeded = true
	} catch (error) {
		if (isAuthError(error)) throw safeLMStudioError(error)
		compatibleError = error
	}

	// Installed @lmstudio/sdk 1.2.0 has no API-token option. Never attempt an
	// unauthenticated WebSocket connection when the user supplied credentials.
	let sdkSucceeded = false
	if (!token) {
		try {
			const client = new LMStudioClient({
				baseUrl: root.replace(/^http/, "ws").replace(/\/$/, ""),
				logger: { info() {}, warn() {}, error() {}, debug() {} },
			})
			const [downloaded, instances] = await Promise.allSettled([
				bounded(client.system.listDownloadedModels()),
				bounded(client.llm.listLoaded().then((items) => Promise.all(items.map((item) => item.getModelInfo())))),
			])
			sdkSucceeded = downloaded.status === "fulfilled" || instances.status === "fulfilled"
			if (downloaded.status === "fulfilled") {
				for (const model of downloaded.value) {
					if (model.type !== "llm") {
						models.delete(model.modelKey)
						models.delete(model.path)
						continue
					}
					models.set(model.modelKey, parseLMStudioModel(model))
				}
			}
			if (instances.status === "fulfilled") {
				// Exact model keys/paths only. Similar names and quantizations are distinct.
				for (const model of instances.value) {
					models.delete(model.modelKey)
					models.delete(model.path)
				}
				for (const model of instances.value) {
					models.set(model.identifier, parseLMStudioModel(model))
					if (positiveNumber(model.contextLength)) loaded.add(model.identifier)
				}
			}
		} catch {
			// REST remains usable when the SDK is unavailable. Never log SDK errors.
		}
	}
	if (!compatibleSucceeded && !sdkSucceeded) throw safeLMStudioError(compatibleError)
	return remember(Object.fromEntries(models))
}
