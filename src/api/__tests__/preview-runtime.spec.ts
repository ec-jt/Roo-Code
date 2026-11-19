import { selectPreviewRuntime } from "../preview-runtime"
import { experimentDefault, experiments, EXPERIMENT_IDS, isCordisRuntimePreviewEnabled } from "../../shared/experiments"

describe("preview runtime selection", () => {
	it("defaults on for absent settings and absent keys", () => {
		expect(experimentDefault.cordisRuntimePreview).toBe(true)
		expect(experiments.isEnabled({}, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(true)
		expect(isCordisRuntimePreviewEnabled(undefined)).toBe(true)
		expect(isCordisRuntimePreviewEnabled({})).toBe(true)
		expect(isCordisRuntimePreviewEnabled({ customTools: true })).toBe(true)
		expect(selectPreviewRuntime("anthropic", undefined)).toBeDefined()
		expect(selectPreviewRuntime("anthropic", { customTools: true })).toBeDefined()
	})

	it("keeps an explicitly stored false off", () => {
		expect(experiments.isEnabled({ cordisRuntimePreview: false }, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(
			false,
		)
		expect(isCordisRuntimePreviewEnabled({ cordisRuntimePreview: false })).toBe(false)
		expect(selectPreviewRuntime("anthropic", { cordisRuntimePreview: false })).toBeUndefined()
	})

	it("only selects the preview runtime for Anthropic, with the flag on or absent", async () => {
		for (const provider of ["openai-native", "openrouter", "bedrock", "vertex", "openai", "gemini", undefined]) {
			expect(selectPreviewRuntime(provider, { cordisRuntimePreview: true })).toBeUndefined()
			expect(selectPreviewRuntime(provider, {})).toBeUndefined()
			expect(selectPreviewRuntime(provider, undefined)).toBeUndefined()
		}
		const runtime = selectPreviewRuntime("anthropic", { cordisRuntimePreview: true })!
		expect(await runtime.admit({} as any, new AbortController().signal)).toMatchObject({ outcome: "granted" })
	})
})
