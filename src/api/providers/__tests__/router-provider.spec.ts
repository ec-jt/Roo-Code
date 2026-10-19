import { type ModelInfo, type ModelRecord } from "@roo-code/types"
import { RouterProvider } from "../router-provider"
import { getModels, getModelsFromCache } from "../fetchers/modelCache"
import type { RouterName } from "../../../shared/api"

vi.mock("../fetchers/modelCache", () => ({ getModels: vi.fn(), getModelsFromCache: vi.fn() }))
vi.mock("openai", () => ({ default: vi.fn().mockImplementation((options) => ({ ...options })) }))
vi.mock("../utils/sdk-timeout", () => ({ configureApiRequestTimeout: (client: unknown) => client }))

const fallback: ModelInfo = { contextWindow: 200000, maxTokens: 8192, supportsPromptCache: false }
const selected: ModelInfo = { ...fallback, contextWindow: 262144, maxTokens: 32768 }

class TestRouter extends RouterProvider {
	constructor(name: RouterName = "litellm", modelId = "private-alias") {
		super({
			name,
			modelId,
			defaultModelId: "default-model",
			defaultModelInfo: fallback,
			baseURL: "https://proxy.example.test",
			apiKey: "test-key",
			options: {},
		})
	}
	async *createMessage() {
		yield { type: "text" as const, text: "" }
	}
	getInstanceModels(): ModelRecord {
		return this.models
	}
}

describe("RouterProvider LiteLLM metadata", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getModels).mockReset()
		vi.mocked(getModelsFromCache).mockReset()
	})

	it("preserves the selected alias before discovery without consulting global cache", () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ "private-alias": selected })
		expect(new TestRouter().getModel()).toEqual({ id: "private-alias", info: fallback })
		expect(getModelsFromCache).not.toHaveBeenCalled()
	})

	it("fetches fresh metadata and retains only the selected model", async () => {
		vi.mocked(getModels).mockResolvedValue({ "private-alias": selected, other: fallback })
		const router = new TestRouter()
		expect(await router.fetchModel()).toEqual({ id: "private-alias", info: selected })
		expect(getModels).toHaveBeenCalledWith({
			provider: "litellm",
			baseUrl: "https://proxy.example.test",
			apiKey: "test-key",
		})
		expect(router.getInstanceModels()).toEqual({ "private-alias": selected })
		vi.mocked(getModels).mockResolvedValue({})
		expect(await router.fetchModel()).toEqual({ id: "private-alias", info: fallback })
		expect(getModels).toHaveBeenCalledTimes(2)
		expect(router.getInstanceModels()).toEqual({})
	})

	it("clears stale metadata after failed discovery without changing the alias", async () => {
		const router = new TestRouter()
		vi.mocked(getModels).mockResolvedValue({ "private-alias": selected })
		await router.fetchModel()
		vi.mocked(getModels).mockRejectedValue(new Error("sanitized discovery failure"))
		await expect(router.fetchModel()).rejects.toThrow("sanitized discovery failure")
		expect(router.getModel()).toEqual({ id: "private-alias", info: fallback })
	})

	it("does not interpret an inherited object property as model metadata", () => {
		expect(new TestRouter("litellm", "constructor").getModel()).toEqual({ id: "constructor", info: fallback })
	})

	it("preserves cache lookup and default-model fallback for other routers", () => {
		vi.mocked(getModelsFromCache).mockReturnValue({ "private-alias": selected })
		expect(new TestRouter("vercel-ai-gateway").getModel()).toEqual({ id: "private-alias", info: selected })
		vi.mocked(getModelsFromCache).mockReturnValue(undefined)
		expect(new TestRouter("vercel-ai-gateway").getModel()).toEqual({ id: "default-model", info: fallback })
	})
})
