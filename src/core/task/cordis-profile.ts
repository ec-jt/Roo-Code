import { taskProfiles, type ModeConfig, type TaskProfile } from "@roo-code/types"

import { isCordisRuntimePreviewEnabled } from "../../shared/experiments"
import { getModeBySlug } from "../../shared/modes"

/** All tool groups, without file restrictions. The `modes` group is always available. */
export const CORDIS_GROUPS = ["read", "edit", "browser", "command", "mcp"] as const

/** Tools that Cordis tasks never get. Hybrid tasks keep them. */
export const CORDIS_DISABLED_TOOLS = ["switch_mode"] as const

/** Tools that only Cordis and hybrid tasks get. They are disabled for the `modes` profile. */
export const CORDIS_ONLY_TOOLS = ["exit_plan"] as const

/** Mode a hybrid task switches to when a plan is approved and the plan names no mode. */
export const HYBRID_DEFAULT_TARGET_MODE = "code"

export function isTaskProfile(value: unknown): value is TaskProfile {
	return typeof value === "string" && (taskProfiles as readonly string[]).includes(value)
}

/**
 * True for profiles with plan review, `/plan`, drift as a plan amendment and the dispatch runtime
 * on Anthropic (`cordis` and `hybrid`). Mode locking and the fixed tool preset are `cordis` only.
 */
export function hasPlanReview(profile: TaskProfile | undefined): boolean {
	return profile === "cordis" || profile === "hybrid"
}

/**
 * Effective profile setting for new top-level tasks. `taskProfile` wins when it is valid. Otherwise
 * the legacy flag decides: a stored `cordisRuntimePreview: false` means modes; `true` or absent
 * means cordis. The legacy key is only read, never rewritten (C-5).
 */
export function effectiveProfileSetting(
	setting: unknown,
	experiments: Record<string, boolean | undefined> | undefined | null,
): TaskProfile {
	if (isTaskProfile(setting)) return setting
	return isCordisRuntimePreviewEnabled(experiments) ? "cordis" : "modes"
}

/**
 * Decides the profile for a new task. Resumed tasks keep their stored profile (an unknown stored
 * value means modes); children inherit their parent's profile; otherwise the profile setting at
 * creation time decides (see effectiveProfileSetting).
 */
export function resolveTaskProfile(options: {
	stored?: unknown
	parent?: TaskProfile
	setting?: unknown
	experiments?: Record<string, boolean | undefined>
}): TaskProfile {
	if (options.stored !== undefined) return isTaskProfile(options.stored) ? options.stored : "modes"
	if (isTaskProfile(options.parent)) return options.parent
	return effectiveProfileSetting(options.setting, options.experiments)
}

/**
 * Returns the tool-filtering inputs for a task.
 * - `cordis`: the active mode is overridden (as a custom mode with the same slug, which takes
 *   precedence) with all tool groups and no fileRegex, and switch_mode is disabled. Role and
 *   instructions of the mode are kept for the prompt.
 * - `hybrid`: custom modes and disabled tools are returned unchanged, so per-mode tool limits,
 *   switch_mode and exit_plan (always available) all stay.
 * - `modes`: the custom modes are returned unchanged and the Cordis-only tools (exit_plan) are disabled.
 */
export function applyProfileToToolInputs(
	profile: TaskProfile | undefined,
	modeSlug: string,
	customModes: ModeConfig[] | undefined,
	disabledTools: string[] | undefined,
): { customModes: ModeConfig[] | undefined; disabledTools: string[] | undefined } {
	if (profile === "hybrid") {
		return { customModes, disabledTools }
	}
	if (profile !== "cordis") {
		return { customModes, disabledTools: [...new Set([...(disabledTools ?? []), ...CORDIS_ONLY_TOOLS])] }
	}
	const base = getModeBySlug(modeSlug, customModes)
	const override: ModeConfig = {
		...(base ?? { slug: modeSlug, name: modeSlug, roleDefinition: "" }),
		slug: modeSlug,
		groups: [...CORDIS_GROUPS],
	}
	return {
		customModes: [override, ...(customModes ?? []).filter((mode) => mode.slug !== modeSlug)],
		disabledTools: [...new Set([...(disabledTools ?? []), ...CORDIS_DISABLED_TOOLS])],
	}
}
