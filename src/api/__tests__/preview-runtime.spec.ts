import { selectPreviewRuntime } from "../preview-runtime"
import { experimentDefault, experiments, EXPERIMENT_IDS } from "../../shared/experiments"

describe("preview runtime selection", () => {
	it("defaults off for absent and migrated settings", () => {
		expect(experimentDefault.cordisRuntimePreview).toBe(false)
		expect(experiments.isEnabled({}, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(false)
		expect(selectPreviewRuntime("anthropic", undefined)).toBeUndefined()
		expect(selectPreviewRuntime("anthropic", { customTools: true })).toBeUndefined()
		expect(selectPreviewRuntime("anthropic", { cordisRuntimePreview: false })).toBeUndefined()
	})
	it("only selects the preview for opted-in Anthropic", async () => {
		for (const provider of ["openrouter", "bedrock", "vertex", "openai", undefined]) {
			expect(selectPreviewRuntime(provider, { cordisRuntimePreview: true })).toBeUndefined()
		}
		const runtime = selectPreviewRuntime("anthropic", { cordisRuntimePreview: true })!
		expect(await runtime.admit({} as any, new AbortController().signal)).toMatchObject({ outcome: "granted" })
	})
})
