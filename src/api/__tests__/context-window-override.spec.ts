// cd src && npx vitest run api/__tests__/context-window-override.spec.ts

import type { ModelInfo, ProviderSettings } from "@roo-code/types"

import { buildApiHandler, withContextWindowOverride } from "../index"
import { AnthropicHandler } from "../providers/anthropic"
import { applyContextWindowOverride, getModelMaxOutputTokens } from "../../shared/api"
import { manageContext } from "../../core/context-management"
import * as condenseModule from "../../core/condense"
import type { ApiMessage } from "../../core/task-persistence/apiMessages"

const opus: ProviderSettings = { apiProvider: "anthropic", apiKey: "test", apiModelId: "claude-opus-5-5" }

describe("applyContextWindowOverride", () => {
	const info: ModelInfo = { contextWindow: 1_000_000, maxTokens: 128_000, supportsPromptCache: true }

	it("lowers the window and caps maxTokens to 20% of the overridden window", () => {
		const result = applyContextWindowOverride(info, { modelContextWindowOverride: 64_000 })
		expect(result.contextWindow).toBe(64_000)
		expect(result.maxTokens).toBe(12_800)
		expect(info.contextWindow).toBe(1_000_000) // input not mutated
	})

	it("keeps a maxTokens that already fits under the cap", () => {
		const result = applyContextWindowOverride({ ...info, maxTokens: 8_192 }, { modelContextWindowOverride: 64_000 })
		expect(result.maxTokens).toBe(8_192)
	})

	it.each([undefined, 0, -5, 1.5, 1_000_000, 2_000_000])("returns the same info for override %s", (override) => {
		expect(applyContextWindowOverride(info, { modelContextWindowOverride: override as number })).toBe(info)
	})
})

describe("buildApiHandler with modelContextWindowOverride", () => {
	it("lowers getModel().info.contextWindow and keeps the handler class", () => {
		const handler = buildApiHandler({ ...opus, modelContextWindowOverride: 64_000 })
		expect(handler).toBeInstanceOf(AnthropicHandler)
		expect(handler.getModel().info.contextWindow).toBe(64_000)
		expect(handler.getModel().id).toBe("claude-opus-5-5")
	})

	it("never raises the window above the model's real window", () => {
		const handler = buildApiHandler({ ...opus, modelContextWindowOverride: 5_000_000 })
		expect(handler.getModel().info.contextWindow).toBe(1_000_000)
	})

	it("changes nothing without an override", () => {
		const plain = buildApiHandler(opus)
		expect(plain.getModel()).toEqual(new AnthropicHandler(opus).getModel())
		expect(plain.getModel().info.contextWindow).toBe(1_000_000)
	})

	it("does not change provider request parameters", () => {
		const real = buildApiHandler(opus).getModel() as ReturnType<AnthropicHandler["getModel"]>
		const overridden = buildApiHandler({ ...opus, modelContextWindowOverride: 64_000 }).getModel() as ReturnType<
			AnthropicHandler["getModel"]
		>
		expect(overridden.maxTokens).toBe(real.maxTokens)
		expect(overridden.reasoning).toEqual(real.reasoning)
		expect(overridden.temperature).toBe(real.temperature)
	})

	it("caps the derived output reserve so a 64k window leaves input space", () => {
		const settings = { ...opus, modelContextWindowOverride: 64_000 }
		const model = buildApiHandler(settings).getModel()
		const reserve = getModelMaxOutputTokens({ modelId: model.id, model: model.info, settings }) ?? 0
		expect(reserve).toBeLessThanOrEqual(12_800)
		expect(model.info.contextWindow - reserve).toBeGreaterThanOrEqual(51_200)
	})

	it("withContextWindowOverride ignores invalid values", () => {
		const handler = new AnthropicHandler(opus)
		const getModel = handler.getModel
		expect(withContextWindowOverride(handler, undefined).getModel).toBe(getModel)
		expect(withContextWindowOverride(handler, 0).getModel).toBe(getModel)
	})
})

describe("manageContext receives the overridden window", () => {
	afterEach(() => vi.restoreAllMocks())

	const big = "x".repeat(20_000)
	const history: ApiMessage[] = [
		{ role: "user", content: "task" },
		{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "read_file", input: {} }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: big }] },
		{ role: "assistant", content: "ok" },
		{ role: "user", content: "latest input" },
	]

	async function run(settings: ProviderSettings) {
		const handler = buildApiHandler(settings)
		vi.spyOn(handler, "countTokens").mockResolvedValue(100_000)
		const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
			messages: [{ role: "user", content: "summary", isSummary: true }],
			summary: "summary",
			cost: 0,
			condenseId: "c1",
		})
		const model = handler.getModel()
		const result = await manageContext({
			messages: history,
			totalTokens: 100_000,
			contextWindow: model.info.contextWindow,
			maxTokens: getModelMaxOutputTokens({ modelId: model.id, model: model.info, settings }),
			apiHandler: handler,
			autoCondenseContext: true,
			contextLimitExceeded: true,
			systemPrompt: "system",
			taskId: "t",
			saveArtifact: async () => "tool-1.txt",
		})
		return { result, summarize }
	}

	it("prunes only with the real 1M window, but summarizes with a 64k override", async () => {
		const real = await run(opus)
		expect(real.result.pruneId).toEqual(expect.any(String))
		expect(real.summarize).not.toHaveBeenCalled()
		vi.restoreAllMocks()

		const overridden = await run({ ...opus, modelContextWindowOverride: 64_000 })
		expect(overridden.result.pruneId).toBeUndefined()
		expect(overridden.summarize).toHaveBeenCalledTimes(1)
	})
})
