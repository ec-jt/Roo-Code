# ADR-2026-11-22-hybrid-task-profile: Hybrid task profile (modes with plan review)

Status: accepted
Accepted-by: user
Last-verified: 2026-11-22
Paths: src/core/task/cordis-profile.ts, src/core/prompts/sections/cordis.ts, src/core/tools/ExitPlanTool.ts, src/api/preview-runtime.ts, packages/types/src/experiment.ts

## Problem

The S2 rerun on 4.2.98 ([evaluation section 10](../../evaluation-2026-11-18.md), `research/eval-2026-11-21b/`) found two things:

- **Cost:** the Cordis profile was cheaper than the modes profile. It cost 10% less and used 18% fewer input tokens, and it was cheaper in 3 of 4 pairs.
- **Quality:** blind review preferred the modes diffs in 3 of 4 pairs. The modes runs enforced the limit in two places and covered all locales. Two of those three verdicts may be biased, because the judge prompt omits the scripted override.

Each profile combines several separate features ([`cordis-profile.ts`](../../../../src/core/task/cordis-profile.ts)):

- **Cordis gains:** plan review (`/plan`, `exit_plan`, `plan_review`) replaces a text plan, a follow-up question and a mode switch.
- **Cordis losses:** it locks the task to one mode, removes per-mode tool limits, and disables `switch_mode`.

The user asked (2026-11-22) whether Cordis and modes can be combined.

## Decision

Add a third task profile, `hybrid`:

| Feature                                    | modes           | cordis          | hybrid               |
| ------------------------------------------ | --------------- | --------------- | -------------------- |
| Mode roles and per-mode tool limits        | yes             | no (all groups) | yes                  |
| `switch_mode`                              | yes             | no              | yes                  |
| `/plan`, `exit_plan`, plan review          | no              | yes             | yes                  |
| Switch to the target mode on plan approval | no              | not needed      | yes (default `code`) |
| Drift as a plan amendment                  | no              | yes             | yes                  |
| `cordisTextOnlyTurnPolicy`                 | normal reminder | yes             | yes                  |
| Dispatch runtime                           | no              | Anthropic       | Anthropic            |

### Rules

1. `TaskProfile` becomes `"modes" | "cordis" | "hybrid"`.
    - A new task takes its profile from the stored value first, then the parent's profile, then the setting.
    - An unknown stored value falls back to `modes`.
2. A profile setting with three values replaces the `cordisRuntimePreview` toggle in Settings > Experimental. An existing stored `cordisRuntimePreview` is read as follows: `true` means `cordis`, `false` means `modes`, and absent means the new default, `cordis`, unchanged. The old key is never rewritten ([C-5](../../constraints.md)).
3. The prompt for `hybrid` adds the plan-mode section and the drift rule from [`cordis.ts`](../../../../src/core/prompts/sections/cordis.ts), without the sentence that says the mode is fixed.
4. In a `hybrid` task, approving a plan switches to the target mode before the task continues. The model and provider profile stay the same ([Q-USE-1](../../quality.md)).
5. `selectPreviewRuntime()` returns the runtime for `cordis` and `hybrid` on Anthropic.

## Alternatives considered

- **Separate toggles for each Cordis feature.** Rejected for now: too many combinations to test.
- **Change Cordis in place.** Rejected: it would remove the arm that the evaluation compares against.
- **Leave the runtime out of hybrid.** Rejected: parallel subtasks need the runtime ([ADR-2026-11-22-parallel-subtasks](../accepted/ADR-2026-11-22-parallel-subtasks.md)), and hybrid should differ from Cordis only in mode handling.

## Consequences

### Acceptance criteria

- Each profile gets the tool set and prompt sections in the table. A test covers each profile.
- In `hybrid`, approving a plan switches to `code` (or to the named mode), and the model stays the same.
- A stored `cordisRuntimePreview: false` still gives `modes`. An unknown stored profile gives `modes`.
- New strings are in all 18 locales ([C-7](../../constraints.md)).

### Risks

- **Default:** the default profile stays `cordis` until the long-task evaluation (L1) decides it.
- **Rollback:** a task stored with `hybrid` and opened in an older build falls back to how that build handles an unknown profile. Check this before release and note it in the release notes.
