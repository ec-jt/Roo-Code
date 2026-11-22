import type { TaskProfile } from "@roo-code/types"

const PLAN_OVERLAY = `PLAN OVERLAY (ON)

The user turned on plan mode for this task. Explore and design before executing. Read files, search, and run read-only commands as needed. Make no edits except to plan or architecture documents. When the plan is ready, call exit_plan with the full plan in Markdown, starting with a heading. Do not implement the plan until the user approves it.`

const CORDIS_DRIFT_RULE = `CORDIS TASK

Architecture drift: when the project has docs/architecture/, this task's mode is fixed. On drift (a constraint would be violated, a decision no longer matches the code, a new structural choice is needed, or a risk materialised) do not ask to switch modes. Stop the conflicting change, record a task_state blocker citing the IDs, and call exit_plan with an amendment: the drift, the proposed record change, and the updated plan. After approval, write the record changes, clear the blocker, and continue. This rule supersedes any mode instruction to ask the user about switching to Architect mode.`

const HYBRID_SECTION = `HYBRID TASK

Plan review: in Architect mode, or any other mode whose role is planning, finish planning by calling exit_plan with the full plan in Markdown, starting with a heading. Do not end planning with a text plan and a follow-up question. When the user approves the plan, the task switches to the mode that implements it (Code unless you pass another mode slug in the exit_plan mode parameter), with the same model.

Architecture drift: when the project has docs/architecture/ and drift occurs (a constraint would be violated, a decision no longer matches the code, a new structural choice is needed, or a risk materialised), stop the conflicting change, record a task_state blocker citing the IDs, and call exit_plan with an amendment: the drift, the proposed record change, and the updated plan. After approval, write the record changes, clear the blocker, and continue.`

/**
 * Task-profile section. Empty for `modes` tasks, so their prompt is unchanged.
 * - `cordis`: the fixed-mode drift rule, plus the plan overlay when on.
 * - `hybrid`: plan review in planning modes and a drift rule without mode locking, plus the plan
 *   overlay when on (ADR-2026-11-22-hybrid-task-profile, rule 3).
 * The text depends only on the profile and the plan overlay, so the prompt cache
 * changes only when the user toggles the overlay.
 */
export function getCordisSection(profile: TaskProfile | undefined, planOverlay: boolean | undefined): string {
	const base = profile === "cordis" ? CORDIS_DRIFT_RULE : profile === "hybrid" ? HYBRID_SECTION : ""
	if (!base) return ""
	return planOverlay ? `${base}\n\n${PLAN_OVERLAY}` : base
}
