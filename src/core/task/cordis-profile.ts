import type { ModeConfig, TaskProfile } from "@roo-code/types"

import { getModeBySlug } from "../../shared/modes"

/** All tool groups, without file restrictions. The `modes` group is always available. */
export const CORDIS_GROUPS = ["read", "edit", "browser", "command", "mcp"] as const

/** Tools that Cordis tasks never get. */
export const CORDIS_DISABLED_TOOLS = ["switch_mode"] as const

/**
 * Decides the profile for a new task. Resumed tasks keep their stored profile; children inherit
 * their parent's profile; otherwise the experiment flag at creation time decides. Missing means modes.
 */
export function resolveTaskProfile(options: {
	stored?: TaskProfile
	parent?: TaskProfile
	experiments?: Record<string, boolean | undefined>
}): TaskProfile {
	if (options.stored) return options.stored
	if (options.parent) return options.parent
	return options.experiments?.cordisRuntimePreview === true ? "cordis" : "modes"
}

/**
 * Returns the tool-filtering inputs for a task. For `cordis`, the active mode is overridden (as a
 * custom mode with the same slug, which takes precedence) with all tool groups and no fileRegex,
 * and switch_mode is disabled. Role and instructions of the mode are kept for the prompt.
 * For `modes`, the inputs are returned unchanged.
 */
export function applyProfileToToolInputs(
	profile: TaskProfile | undefined,
	modeSlug: string,
	customModes: ModeConfig[] | undefined,
	disabledTools: string[] | undefined,
): { customModes: ModeConfig[] | undefined; disabledTools: string[] | undefined } {
	if (profile !== "cordis") return { customModes, disabledTools }
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
