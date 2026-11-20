// npx vitest run src/shared/__tests__/experiments.spec.ts

import type { ExperimentId } from "@roo-code/types"

import {
	EXPERIMENT_IDS,
	experimentConfigsMap,
	experimentDefault,
	experiments as Experiments,
	isCordisRuntimePreviewEnabled,
} from "../experiments"

describe("experiments", () => {
	describe("PREVENT_FOCUS_DISRUPTION", () => {
		it("is configured correctly", () => {
			expect(EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION).toBe("preventFocusDisruption")
			expect(experimentConfigsMap.PREVENT_FOCUS_DISRUPTION).toMatchObject({
				enabled: false,
			})
		})
	})

	describe("CORDIS_RUNTIME_PREVIEW", () => {
		it("is on by default; absent means on and a stored false means off", () => {
			expect(experimentConfigsMap.CORDIS_RUNTIME_PREVIEW).toMatchObject({ enabled: true })
			expect(experimentDefault.cordisRuntimePreview).toBe(true)
			expect(Experiments.isEnabled({}, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(true)
			expect(Experiments.isEnabled({ cordisRuntimePreview: false }, EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW)).toBe(
				false,
			)
			expect(isCordisRuntimePreviewEnabled(undefined)).toBe(true)
			expect(isCordisRuntimePreviewEnabled(null)).toBe(true)
			expect(isCordisRuntimePreviewEnabled({ cordisRuntimePreview: true })).toBe(true)
			expect(isCordisRuntimePreviewEnabled({ cordisRuntimePreview: false })).toBe(false)
		})
	})

	describe("EVALUATION_RECORDING", () => {
		it("is off by default; only a stored true turns it on", () => {
			expect(EXPERIMENT_IDS.EVALUATION_RECORDING).toBe("evaluationRecording")
			expect(experimentConfigsMap.EVALUATION_RECORDING).toMatchObject({ enabled: false })
			expect(experimentDefault.evaluationRecording).toBe(false)
			expect(Experiments.isEnabled({}, EXPERIMENT_IDS.EVALUATION_RECORDING)).toBe(false)
			expect(Experiments.isEnabled({ evaluationRecording: true }, EXPERIMENT_IDS.EVALUATION_RECORDING)).toBe(true)
		})
	})

	describe("isEnabled", () => {
		it("returns false when experiment is not enabled", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				cordisRuntimePreview: false,
				evaluationRecording: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)
		})

		it("returns true when experiment is enabled", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: true,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				cordisRuntimePreview: false,
				evaluationRecording: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(true)
		})

		it("returns false when experiment is not present", () => {
			const experiments: Record<ExperimentId, boolean> = {
				preventFocusDisruption: false,
				imageGeneration: false,
				runSlashCommand: false,
				customTools: false,
				cordisRuntimePreview: false,
				evaluationRecording: false,
			}
			expect(Experiments.isEnabled(experiments, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)).toBe(false)
		})
	})
})
