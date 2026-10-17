import axios from "axios"
import { type LLMInfo, type LLMInstanceInfo, LMStudioClient } from "@lmstudio/sdk"

import { lMStudioDefaultModelInfo } from "@roo-code/types"

import {
	forceFullModelDetailsLoad,
	getLMStudioModels,
	getCachedLMStudioModels,
	hasLoadedFullDetails,
	parseLMStudioModel,
} from "../lmstudio"
import { MODEL_FETCH_TIMEOUT_MS } from "../fetch-timeout"
import { normalizeLMStudioBaseUrl, safeLMStudioError } from "../../utils/lm-studio-config"

vi.mock("axios")
const { listDownloadedModels, listLoaded, loadModel } = vi.hoisted(() => ({
	listDownloadedModels: vi.fn(),
	listLoaded: vi.fn(),
	loadModel: vi.fn(),
}))
vi.mock("@lmstudio/sdk", () => ({
	LMStudioClient: vi.fn().mockImplementation(() => ({
		llm: { listLoaded, model: loadModel, load: loadModel },
		system: { listDownloadedModels },
	})),
}))

const baseUrl = "http://localhost:1234"
const unavailable = { response: { status: 404 } }
const downloaded: LLMInfo = {
	type: "llm",
	modelKey: "publisher/model",
	path: "publisher/model/model-Q4.gguf",
	displayName: "Model",
	format: "gguf",
	sizeBytes: 1000,
	vision: true,
	trainedForToolUse: true,
	maxContextLength: 131072,
}
const instance: LLMInstanceInfo = {
	...downloaded,
	identifier: "custom-inference-id",
	instanceReference: "instance-1",
	contextLength: 126720,
}
const nativeModel = {
	type: "llm",
	key: downloaded.modelKey,
	display_name: "Model",
	max_context_length: 131072,
	capabilities: { vision: true },
	loaded_instances: [{ id: instance.identifier, config: { context_length: 126720 } }],
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(LMStudioClient).mockImplementation(
		() =>
			({
				llm: { listLoaded, model: loadModel, load: loadModel },
				system: { listDownloadedModels },
			}) as unknown as LMStudioClient,
	)
	vi.mocked(axios.get).mockReset().mockRejectedValue(unavailable)
	listDownloadedModels.mockReset().mockRejectedValue(new Error("SDK unavailable"))
	listLoaded.mockReset().mockRejectedValue(new Error("SDK unavailable"))
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("LM Studio configuration", () => {
	it.each([
		[undefined, `${baseUrl}/`],
		["  ", `${baseUrl}/`],
		[`${baseUrl}/v1///`, `${baseUrl}/`],
		["https://server.example/proxy/v1/", "https://server.example/proxy/"],
		["https://server.example/proxy/", "https://server.example/proxy/"],
		["http://[::1]:1234/v1", "http://[::1]:1234/"],
	])("normalizes %s", (input, expected) => {
		expect(normalizeLMStudioBaseUrl(input)).toBe(expected)
	})

	it.each([
		"ftp://server",
		"ws://server",
		"not a URL",
		"http://secret:token@server",
		"http://server/?token=secret",
		"http://server/#secret",
		"http://server/?",
		"http://server/#",
	])("rejects unsafe configuration without echoing input", (input) => {
		expect(() => normalizeLMStudioBaseUrl(input)).toThrow("Invalid LM Studio base URL")
		try {
			normalizeLMStudioBaseUrl(input)
		} catch (error) {
			expect(String(error)).not.toContain(input)
		}
	})

	it("returns fixed errors without preserving the original error or its cause", () => {
		const error = safeLMStudioError({
			message: "secret-token",
			response: { status: 502, data: "secret-token" },
			config: { headers: { Authorization: "Bearer secret-token" } },
		})
		expect(error.message).toBe("LM Studio model discovery failed (HTTP 502).")
		expect(error).not.toHaveProperty("cause")
		expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("secret-token")
	})
})

describe("LM Studio discovery", () => {
	it("parses downloaded limits and prefers loaded runtime context", () => {
		expect(parseLMStudioModel(downloaded).contextWindow).toBe(131072)
		expect(parseLMStudioModel(instance)).toEqual({
			...lMStudioDefaultModelInfo,
			description: "Model - publisher/model/model-Q4.gguf",
			contextWindow: 126720,
			maxTokens: 126720,
			supportsImages: true,
		})
	})

	it("lists native loaded and unloaded chat models, excluding embeddings and decision models", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				models: [
					nativeModel,
					{ ...nativeModel, key: "other/model", loaded_instances: [] },
					{ type: "embedding", key: "embedding" },
					{ type: "decision", key: "decision" },
				],
			},
		})
		const result = await getLMStudioModels(`${baseUrl}/v1/`, " test-token ")
		expect(Object.keys(result)).toEqual([instance.identifier, "other/model"])
		expect(result[instance.identifier]).toMatchObject({
			contextWindow: 126720,
			maxTokens: 126720,
			supportsImages: true,
		})
		expect(result["other/model"].contextWindow).toBe(131072)
		expect(axios.get).toHaveBeenCalledExactlyOnceWith(`${baseUrl}/api/v1/models`, {
			timeout: MODEL_FETCH_TIMEOUT_MS,
			maxRedirects: 0,
			maxContentLength: 10 * 1024 * 1024,
			headers: { Authorization: "Bearer test-token" },
		})
		expect(LMStudioClient).not.toHaveBeenCalled()
		expect(loadModel).not.toHaveBeenCalled()
	})

	it.each([undefined, "", "   "])("omits authorization when no token is configured", async (token) => {
		vi.mocked(axios.get).mockResolvedValueOnce({ data: { models: [] } })
		expect(await getLMStudioModels(undefined, token)).toEqual({})
		expect(vi.mocked(axios.get).mock.calls[0][1]).not.toHaveProperty("headers")
		expect(LMStudioClient).not.toHaveBeenCalled()
	})

	it("retains multiple loaded instances and their separate contexts", async () => {
		vi.mocked(axios.get).mockResolvedValueOnce({
			data: {
				models: [
					{
						...nativeModel,
						loaded_instances: [
							...nativeModel.loaded_instances,
							{ id: "second", config: { context_length: 4096 } },
						],
					},
				],
			},
		})
		const result = await getLMStudioModels(baseUrl)
		expect(Object.keys(result)).toEqual([instance.identifier, "second"])
		expect(result.second.contextWindow).toBe(4096)
	})

	it("falls back to the compatible list when the native endpoint and SDK are unavailable", async () => {
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce({ data: { data: [{ id: "chat" }] } })
		expect(await getLMStudioModels(baseUrl)).toEqual({ chat: { ...lMStudioDefaultModelInfo, description: "chat" } })
		expect(axios.get).toHaveBeenNthCalledWith(
			2,
			`${baseUrl}/v1/models`,
			expect.objectContaining({ timeout: 10000, maxRedirects: 0 }),
		)
	})

	it("uses authenticated REST fallback without attempting SDK access", async () => {
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce({ data: { data: [{ id: "chat" }, { id: "embed", type: "embedding" }] } })
		expect(Object.keys(await getLMStudioModels(baseUrl, "test-token"))).toEqual(["chat"])
		expect(axios.get).toHaveBeenNthCalledWith(
			2,
			`${baseUrl}/v1/models`,
			expect.objectContaining({ headers: { Authorization: "Bearer test-token" }, maxRedirects: 0 }),
		)
		expect(LMStudioClient).not.toHaveBeenCalled()
	})

	it("uses SDK metadata and exact identity, not substring matches, for REST enrichment", async () => {
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce({ data: { data: [{ id: downloaded.modelKey }, { id: "embedding" }] } })
		listDownloadedModels.mockResolvedValueOnce([
			downloaded,
			{ ...downloaded, modelKey: "publisher/model-Q8", path: "publisher/model/Q8" },
			{ type: "embedding", modelKey: "embedding", path: "embedding/path" },
		])
		listLoaded.mockResolvedValueOnce([{ getModelInfo: vi.fn().mockResolvedValue(instance) }])
		const result = await getLMStudioModels("https://server.example/proxy/v1")
		expect(Object.keys(result)).toEqual(["publisher/model-Q8", instance.identifier])
		expect(result[instance.identifier].contextWindow).toBe(126720)
		expect(LMStudioClient).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "wss://server.example/proxy" }))
		expect(listDownloadedModels).toHaveBeenCalledWith()
		expect(loadModel).not.toHaveBeenCalled()
	})

	it("can discover via SDK when both HTTP endpoints are unavailable", async () => {
		listDownloadedModels.mockResolvedValueOnce([downloaded])
		expect(Object.keys(await getLMStudioModels(baseUrl))).toEqual([downloaded.modelKey])
	})

	it("preserves all SDK loaded instances sharing one model key", async () => {
		listDownloadedModels.mockResolvedValueOnce([downloaded])
		listLoaded.mockResolvedValueOnce([
			{ getModelInfo: vi.fn().mockResolvedValue(instance) },
			{
				getModelInfo: vi
					.fn()
					.mockResolvedValue({ ...instance, identifier: downloaded.modelKey, contextLength: 4096 }),
			},
		])
		const result = await getLMStudioModels(baseUrl)
		expect(Object.keys(result)).toEqual([instance.identifier, downloaded.modelKey])
		expect(result[downloaded.modelKey].contextWindow).toBe(4096)
	})

	it.each([401, 403])("does not hide native HTTP %s authentication failures or try fallback", async (status) => {
		vi.mocked(axios.get).mockRejectedValueOnce({ response: { status }, config: { secret: "test-token" } })
		await expect(getLMStudioModels(baseUrl, "test-token")).rejects.toThrow(`authentication failed (HTTP ${status})`)
		expect(axios.get).toHaveBeenCalledTimes(1)
		expect(LMStudioClient).not.toHaveBeenCalled()
	})

	it("does not hide compatible endpoint authentication failures behind SDK results", async () => {
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockRejectedValueOnce({ response: { status: 401 } })
		await expect(getLMStudioModels(baseUrl)).rejects.toThrow("authentication failed")
		expect(LMStudioClient).not.toHaveBeenCalled()
	})

	it("throws a sanitized failure instead of returning an empty catalog", async () => {
		const warn = vi.spyOn(console, "warn")
		const error = vi.spyOn(console, "error")
		vi.mocked(axios.get).mockRejectedValue({
			code: "ECONNREFUSED",
			message: "test-token",
			config: { secret: "test-token" },
		})
		await expect(getLMStudioModels(baseUrl, "test-token")).rejects.toThrow("Could not connect to LM Studio")
		expect(warn).not.toHaveBeenCalled()
		expect(error).not.toHaveBeenCalled()
	})

	it("rejects invalid URLs before sending any request", async () => {
		await expect(getLMStudioModels("http://token@server")).rejects.toThrow("Invalid LM Studio base URL")
		expect(axios.get).not.toHaveBeenCalled()
	})

	it("rejects malformed endpoint responses when no discovery method succeeds", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { error: "secret-token" } })
		await expect(getLMStudioModels(baseUrl, "test-token")).rejects.toThrow("Could not discover LM Studio models")
	})

	it("accepts a valid empty compatible list even if SDK enrichment fails", async () => {
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce({ data: { data: [] } })
		expect(await getLMStudioModels(baseUrl)).toEqual({})
	})

	it("bounds SDK waits and preserves REST results", async () => {
		vi.useFakeTimers()
		vi.mocked(axios.get)
			.mockRejectedValueOnce(unavailable)
			.mockResolvedValueOnce({ data: { data: [{ id: "chat" }] } })
		listDownloadedModels.mockReturnValueOnce(new Promise(() => {}))
		listLoaded.mockResolvedValueOnce([{ getModelInfo: () => new Promise(() => {}) }])
		const result = getLMStudioModels(baseUrl)
		await vi.advanceTimersByTimeAsync(MODEL_FETCH_TIMEOUT_MS)
		expect(Object.keys(await result)).toEqual(["chat"])
		expect(vi.getTimerCount()).toBe(0)
	})

	it("reports HTTP timeouts without leaking the underlying request", async () => {
		vi.mocked(axios.get).mockRejectedValue({ code: "ECONNABORTED", request: "secret-token" })
		await expect(getLMStudioModels(baseUrl, "test-token")).rejects.toThrow("LM Studio model discovery timed out.")
	})

	it("scopes loaded metadata by normalized endpoint and token, and clears only the refreshed scope", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { models: [nativeModel] } })
		await getLMStudioModels(baseUrl, "one")
		await getLMStudioModels("https://other.example", "two")
		expect(hasLoadedFullDetails(instance.identifier, `${baseUrl}/v1/`, "one")).toBe(true)
		expect(hasLoadedFullDetails(instance.identifier, baseUrl, "two")).toBe(false)
		expect(getCachedLMStudioModels(baseUrl, "two")).toBeUndefined()
		expect(getCachedLMStudioModels(baseUrl, "one")?.[instance.identifier].contextWindow).toBe(126720)
		expect(hasLoadedFullDetails(instance.identifier, "https://other.example", "two")).toBe(true)
		vi.mocked(axios.get).mockResolvedValueOnce({ data: { models: [] } })
		await getLMStudioModels(baseUrl, "one")
		expect(hasLoadedFullDetails(instance.identifier, baseUrl, "one")).toBe(false)
		expect(getCachedLMStudioModels(baseUrl, "one")).toEqual({})
		expect(hasLoadedFullDetails(instance.identifier, "https://other.example", "two")).toBe(true)
	})

	it("refreshes details with optional credentials without loading models or using the shared cache", async () => {
		vi.mocked(axios.get).mockResolvedValue({ data: { models: [nativeModel] } })
		await forceFullModelDetailsLoad(baseUrl, instance.identifier, "test-token")
		expect(hasLoadedFullDetails(instance.identifier, baseUrl, "test-token")).toBe(true)
		expect(loadModel).not.toHaveBeenCalled()
		expect(LMStudioClient).not.toHaveBeenCalled()
	})
})
