import type { ModeConfig, TaskProfile } from "@roo-code/types"

import { isCordisRuntimePreviewEnabled } from "../../shared/experiments"
import { getModeBySlug } from "../../shared/modes"

/** All tool groups, without file restrictions. The `modes` group is always available. */
export const CORDIS_GROUPS = ["read", "edit", "browser", "command", "mcp"] as const

/** Tools that Cordis tasks never get. */
export const CORDIS_DISABLED_TOOLS = ["switch_mode"] as const

/** Tools that only Cordis tasks get. They are disabled for the `modes` profile. */
export const CORDIS_ONLY_TOOLS = ["exit_plan"] as const

/**
 * Decides the profile for a new task. Resumed tasks keep their stored profile; children inherit
 * their parent's profile; otherwise the experiment flag at creation time decides. The flag is on by
 * default: an absent key means cordis, a stored `false` means modes.
 */
export function resolveTaskProfile(options: {
	stored?: TaskProfile
	parent?: TaskProfile
	experiments?: Record<string, boolean | undefined>
}): TaskProfile {
	if (options.stored) return options.stored
	if (options.parent) return options.parent
	return isCordisRuntimePreviewEnabled(options.experiments) ? "cordis" : "modes"
}

/**
 * Returns the tool-filtering inputs for a task. For `cordis`, the active mode is overridden (as a
 * custom mode with the same slug, which takes precedence) with all tool groups and no fileRegex,
 * and switch_mode is disabled. Role and instructions of the mode are kept for the prompt.
 * For `modes`, the custom modes are returned unchanged and the Cordis-only tools (exit_plan) are disabled.
 */
export function applyProfileToToolInputs(
	profile: TaskProfile | undefined,
	modeSlug: string,
	customModes: ModeConfig[] | undefined,
	disabledTools: string[] | undefined,
): { customModes: ModeConfig[] | undefined; disabledTools: string[] | undefined } {
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
