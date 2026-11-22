import { selectPreviewRuntime } from "../preview-runtime"
import { experimentDefault, experiments, EXPERIMENT_IDS, isCordisRuntimePreviewEnabled } from "../../shared/experiments"

describe("preview runtime selection", () => {
	it("keeps the legacy flag default on for absent settings and absent keys", () => {
		expect(experimentDefault.cordisRuntimePreview).toBe(true)
		expect(experiments.isEnabled({}, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(true)
		expect(isCordisRuntimePreviewEnabled(undefined)).toBe(true)
		expect(isCordisRuntimePreviewEnabled({})).toBe(true)
		expect(isCordisRuntimePreviewEnabled({ customTools: true })).toBe(true)
		expect(isCordisRuntimePreviewEnabled({ cordisRuntimePreview: false })).toBe(false)
	})

	it("selects the runtime for cordis and hybrid tasks on Anthropic", async () => {
		expect(selectPreviewRuntime("anthropic", "cordis")).toBeDefined()
		expect(selectPreviewRuntime("anthropic", "hybrid")).toBeDefined()
		const runtime = selectPreviewRuntime("anthropic", "hybrid")!
		expect(await runtime.admit({} as any, new AbortController().signal)).toMatchObject({ outcome: "granted" })
	})

	it("selects no runtime when the current profile setting is modes (kill switch)", () => {
		expect(selectPreviewRuntime("anthropic", "cordis", "modes")).toBeUndefined()
		expect(selectPreviewRuntime("anthropic", "hybrid", "modes")).toBeUndefined()
		expect(selectPreviewRuntime("anthropic", "hybrid", "cordis")).toBeDefined()
		expect(selectPreviewRuntime("anthropic", "cordis", "hybrid")).toBeDefined()
	})

	it("does not select the runtime for modes tasks or an unknown profile", () => {
		expect(selectPreviewRuntime("anthropic", "modes")).toBeUndefined()
		expect(selectPreviewRuntime("anthropic", undefined)).toBeUndefined()
	})

	it("does not select the runtime for other providers", () => {
		for (const provider of ["openai-native", "openrouter", "bedrock", "vertex", "openai", "gemini", undefined]) {
			for (const profile of ["modes", "cordis", "hybrid"] as const) {
				expect(selectPreviewRuntime(provider, profile)).toBeUndefined()
			}
		}
	})
})
