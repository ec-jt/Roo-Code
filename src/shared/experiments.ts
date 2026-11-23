import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@roo-code/types"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	IMAGE_GENERATION: "imageGeneration",
	RUN_SLASH_COMMAND: "runSlashCommand",
	CUSTOM_TOOLS: "customTools",
	CORDIS_RUNTIME_PREVIEW: "cordisRuntimePreview",
	EVALUATION_RECORDING: "evaluationRecording",
	PARALLEL_SUBTASKS: "parallelSubtasks",
} as const satisfies Record<string, ExperimentId>

type _AssertExperimentIds = AssertEqual<Equals<ExperimentId, Values<typeof EXPERIMENT_IDS>>>

type ExperimentKey = Keys<typeof EXPERIMENT_IDS>

interface ExperimentConfig {
	enabled: boolean
}

export const experimentConfigsMap: Record<ExperimentKey, ExperimentConfig> = {
	PREVENT_FOCUS_DISRUPTION: { enabled: false },
	IMAGE_GENERATION: { enabled: false },
	RUN_SLASH_COMMAND: { enabled: false },
	CUSTOM_TOOLS: { enabled: false },
	// Off by default (ADR-2026-11-23-modes-default-profile). Only a stored `true` selects cordis.
	CORDIS_RUNTIME_PREVIEW: { enabled: false },
	// Off by default (ADR-2026-11-20-feature-gating-evaluation-and-lessons). Writes evaluation.json for new tasks.
	EVALUATION_RECORDING: { enabled: false },
	// Off by default (ADR-2026-11-22-parallel-subtasks). Offers the new_tasks tool.
	PARALLEL_SUBTASKS: { enabled: false },
}

export const experimentDefault = Object.fromEntries(
	Object.entries(experimentConfigsMap).map(([_, config]) => [
		EXPERIMENT_IDS[_ as keyof typeof EXPERIMENT_IDS] as ExperimentId,
		config.enabled,
	]),
) as Record<ExperimentId, boolean>

export const experiments = {
	get: (id: ExperimentKey): ExperimentConfig | undefined => experimentConfigsMap[id],
	isEnabled: (experimentsConfig: Experiments, id: ExperimentId) => experimentsConfig[id] ?? experimentDefault[id],
} as const

/**
 * Effective value of the legacy Cordis runtime preview flag (ADR-2026-11-23-modes-default-profile):
 * true only when `true` is stored. An absent key or absent experiments object means off. Stored
 * values are never rewritten (C-5).
 */
export function isCordisRuntimePreviewEnabled(
	experimentsConfig: Partial<Record<string, boolean | undefined>> | undefined | null,
): boolean {
	return experimentsConfig?.[EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW] === true
}
