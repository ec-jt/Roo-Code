import type { TaskProfile } from "@roo-code/types"

/**
 * Cordis task section. Empty for `modes` tasks, so their prompt is unchanged.
 * The text depends only on the profile and the plan overlay, so the prompt cache
 * changes only when the user toggles the overlay.
 */
export function getCordisSection(profile: TaskProfile | undefined, planOverlay: boolean | undefined): string {
	if (profile !== "cordis") return ""

	const driftRule = `CORDIS TASK

Architecture drift: when the project has docs/architecture/, this task's mode is fixed. On drift (a constraint would be violated, a decision no longer matches the code, a new structural choice is needed, or a risk materialised) do not ask to switch modes. Stop the conflicting change, record a task_state blocker citing the IDs, and call exit_plan with an amendment: the drift, the proposed record change, and the updated plan. After approval, write the record changes, clear the blocker, and continue. This rule supersedes any mode instruction to ask the user about switching to Architect mode.`

	if (!planOverlay) return driftRule

	return `${driftRule}

PLAN OVERLAY (ON)

The user turned on plan mode for this task. Explore and design before executing. Read files, search, and run read-only commands as needed. Make no edits except to plan or architecture documents. When the plan is ready, call exit_plan with the full plan in Markdown, starting with a heading. Do not implement the plan until the user approves it.`
}
