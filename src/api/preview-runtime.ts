import type { TaskProfile } from "@roo-code/types"

import type { ModelDispatchRuntime } from "./dispatch-admission"

/** Transport admission preview only: no graph scheduler, ledger, or financial caps. */
const previewRuntime: ModelDispatchRuntime = {
	async admit() {
		return { outcome: "granted", settle: () => {} }
	},
}

/**
 * Returns the preview dispatch runtime for a task. Only `cordis` and `hybrid` tasks get it
 * (ADR-2026-11-22-hybrid-task-profile, rule 5), and only on Anthropic (R-5).
 * `currentSetting` is the effective profile setting now (taskProfile, or the legacy flag). When it
 * is `modes`, no task gets the runtime: this keeps the existing kill switch for resumed tasks.
 */
export function selectPreviewRuntime(
	provider: string | undefined,
	profile: TaskProfile | undefined,
	currentSetting?: TaskProfile,
): ModelDispatchRuntime | undefined {
	if (provider !== "anthropic" || currentSetting === "modes") return undefined
	return profile === "cordis" || profile === "hybrid" ? previewRuntime : undefined
}
