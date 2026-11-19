import type { AssertEqual, Equals, Keys, Values, ExperimentId, Experiments } from "@roo-code/types"

export const EXPERIMENT_IDS = {
	PREVENT_FOCUS_DISRUPTION: "preventFocusDisruption",
	IMAGE_GENERATION: "imageGeneration",
	RUN_SLASH_COMMAND: "runSlashCommand",
	CUSTOM_TOOLS: "customTools",
	CORDIS_RUNTIME_PREVIEW: "cordisRuntimePreview",
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
	// On by default (ADR-2026-11-19-keep-cordis-profile-widen-experiment). A stored `false` stays off.
	CORDIS_RUNTIME_PREVIEW: { enabled: true },
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
 * Effective value of the Cordis runtime preview flag: the stored value when present, else the
 * default (on). An absent key or absent experiments object means on; a stored `false` means off.
 */
export function isCordisRuntimePreviewEnabled(
	experimentsConfig: Partial<Record<string, boolean | undefined>> | undefined | null,
): boolean {
	const stored = experimentsConfig?.[EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW]
	return typeof stored === "boolean" ? stored : experimentDefault[EXPERIMENT_IDS.CORDIS_RUNTIME_PREVIEW]
}
