# ADR-2026-11-19-keep-cordis-profile-widen-experiment: Keep the Cordis profile and widen the experiment

Status: accepted
Accepted-by: user
Last-verified: 2026-11-19
Paths: src/api/preview-runtime.ts, src/api/dispatch-admission.ts, src/core/tools/ExitPlanTool.ts, src/core/task/Task.ts

## Problem

The Cordis runtime preview ("Cordis profile") is an opt-in experiment. It runs a task with a fixed preset and a plan overlay. A `/plan` request produces a `plan_review` that the user approves or sends back. During the task, Cordis can propose a drift amendment as a second plan review. Question Q2 of [the 2026-11-18 evaluation](../../evaluation-2026-11-18.md) asks whether this profile does the same work as the modes profile with fewer turns or tokens. The modes profile plans in Architect mode and then switches to Code mode.

Evaluation S2 used the same feature request, the same model (`claude-opus-5-5`), Architecture context set to Constraints, and the same drift message:

| Run       | Requests | Tokens in / out    | Cost  | Plan reviews | Drift handling                                            | Diff |
| --------- | -------- | ------------------ | ----- | ------------ | --------------------------------------------------------- | ---- |
| S2-modes  | 42       | 5,430,345 / 52,601 | $2.50 | 1            | reported (follow-up question citing C-5)                  | good |
| S2-cordis | 34       | 3,258,515 / 29,257 | $1.65 | 2            | reported (amendment citing C-5 and Q-REL-1; proposed ADR) | good |

S2-cordis did better on requests (19% fewer), input tokens (40% fewer) and cost (34% lower). The outcome and the drift handling were the same. This meets decision rule 1 for Q2 in section 6 of the evaluation.

A second sample on 4.2.80 confirmed the cost result:

| Run          | Requests | Tokens in / out    | Cost  | Plan reviews | Drift handling                                | Outcome                                          |
| ------------ | -------- | ------------------ | ----- | ------------ | --------------------------------------------- | ------------------------------------------------ |
| S2-modes-r2  | 50       | 6,584,166 / 40,482 | $2.81 | 1            | reported (C-5 follow-up)                      | completed; good                                  |
| S2-cordis-r2 | 30       | 2,684,827 / 34,152 | $1.47 | 2            | reported (amendment citing C-5, Q-REL-1, R-2) | text-only finish, then `resume_task`; acceptable |

Over the two samples, Cordis used about 30% fewer requests and about 50% fewer input tokens, and cost about 40% less. Drift was reported in all four runs. The outcome was not equal in sample 2: the Cordis run ended without `attempt_completion`.

The sample 2 ending was then investigated. With Cordis on, a reply without a tool call ended the turn and asked `resume_task`, with no "use a tool" reminder. The modes profile sends that reminder. 4.2.81 added the setting `cordisTextOnlyTurnPolicy`: the default `retryThenPause` sends one reminder once the task has used a tool, then pauses if the next reply also has no tool call.

Two more samples followed:

| Run           | Build  | Requests | Tokens in / out    | Cost  | Plan reviews            | Drift handling                           | Outcome                                                     |
| ------------- | ------ | -------- | ------------------ | ----- | ----------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| S2-modes-r3   | 4.2.81 | 33       | 3,674,800 / 35,766 | $1.94 | 1                       | reported (C-5, Q-REL-1 follow-up)        | completed; good                                             |
| S2-cordis-r3  | 4.2.81 | 28       | 2,544,714 / 24,445 | $1.52 | 1                       | not rateable: drift message lost         | completed; good                                             |
| S2-modes-r3b  | 4.2.82 | 48       | 5,551,887 / 49,607 | $2.69 | 0 (plan in a follow-up) | reported (C-5, Q-REL-1 follow-up)        | completed; good; cost probably inflated by a 37-minute wait |
| S2-cordis-r3b | 4.2.82 | 35       | 3,511,983 / 35,939 | $1.79 | 2                       | reported (amendment citing C-5, Q-REL-1) | completed after one tool reminder; good                     |

- In S2-cordis-r3 the drift message was lost to a defect that is not specific to Cordis: a chat message sent after an auto-approved ask was stored with no ask waiting, and the next ask cleared it. 4.2.82 queues such messages.
- In S2-cordis-r3b the drift message and the override both arrived. The run replied once without a tool call, got the 4.2.81 reminder, and completed.

Over all four samples, Cordis used 27% fewer requests (127 vs 173) and 44% fewer input tokens (12.0M vs 21.2M), and cost 35% less ($6.43 vs $9.94). Cordis was cheaper in every sample.

## Decision

1. Keep the Cordis profile. Do not remove it or move it behind more settings.
2. Turn the experiment on by default for all providers:
    - Set the default of `cordisRuntimePreview` to on. New root tasks then use the Cordis profile on every provider. A stored `false` (a user who turned it off) stays off. Existing tasks keep their stored profile.
    - The Cordis profile itself does not depend on the provider: the prompt section, the tool set (all groups, `exit_plan`, no `switch_mode`) and the plan overlay come from `cordis-profile.ts` and `sections/cordis.ts`.
    - Only the dispatch runtime stays Anthropic-only ([R-5](../../risks.md) stays open for it). `selectPreviewRuntime()` still returns a runtime only for `anthropic`. On other providers a Cordis task has no runtime, so:
        - a reply without a tool call takes the normal "use a tool" reminder path, and `cordisTextOnlyTurnPolicy` has no effect;
        - there is no dispatch admission; requests go out as in the modes profile.
    - Keep the toggle in Settings > Experimental with a short description of `/plan` and drift amendments, so users can turn it off.
    - Keep `cordisTextOnlyTurnPolicy` at `retryThenPause` by default. Users who want the old chat-style pause can choose `alwaysPause`.
    - The samples support the change: Cordis was cheaper in all four, and on 4.2.82 the outcome was equal. All samples used Anthropic; see Risks.
3. Give the amendment review a text field. In S2-cordis the amendment had only Approve and Keep planning buttons, so a scripted override had to go in as a separate chat message.

## Alternatives considered

- **Keep the experiment as it is.** This collects no new evidence, and the measured savings stay unused.
- **Turn the profile on by default for Anthropic profiles only.** Rejected by the user: the profile does not depend on the provider, and only the dispatch runtime is Anthropic-only. Limiting the profile would keep the measured savings from most users.
- **Run an S2 pair on a non-Anthropic model first.** Not chosen. It stays a recommended follow-up (see Consequences).
- **Remove the profile.** Rejected: the evaluation measured savings with no loss in quality.

## Consequences

Evidence at acceptance:

- Cordis used fewer requests and tokens in all four samples, reported drift in every run where the message arrived, and had an equal outcome on 4.2.82 (r3b). Sample 2 was not equal; its cause is fixed in 4.2.81.
- The plain-text ending of sample 2 is explained (a Cordis code path, fixed in 4.2.81). r3 and r3b both ended with `attempt_completion`, and in r3b the retry path ran once in a live task.

Required in the implementation:

- With the default on, a new root task uses the Cordis profile on every provider, and a stored `cordisRuntimePreview: false` stays off. Covered by unit tests.
- On a provider other than Anthropic, a Cordis task gets no dispatch runtime, and a reply without a tool call gets the normal reminder. Covered by unit tests.
- The release notes say that Cordis is now on by default, what changes for users (mode locked after the first request, no `switch_mode`), and how to turn it off.

Follow-ups:

- Run an S2 pair on a non-Anthropic model (for example GPT through `openai-native`). If Cordis does worse there, turn the default off for that provider.
- Give the amendment review a free-text field whose text reaches the model as a user message. Until then, a chat message sent right after the approval is queued and delivered (checked in r3b on 4.2.82).

Risks:

- **Sample size:** this decision rests on four samples per run, one of which (r3) is not rateable for drift, and another (r3b) has an inflated modes cost.
- **Little evidence outside Anthropic:** sample r5 (4.2.84) ran one pair on `deepseek-flash`. Cordis worked there without the dispatch runtime (`/plan`, `exit_plan`, `plan_review`, drift reported), but both arms hit the protocol's 60-request limit, so no saving is measured. A `task_state` argument defect on DeepSeek was found and fixed in 4.2.85.
- **Saving varies by run:** in r5 Cordis cost more than modes on Opus ($2.31 vs $1.86). Over five Opus samples it still cost 26% less in total. See section 8 of the evaluation.
- **Existing users:** users who never touched the toggle get Cordis on their next new task. Their mode is then locked after the first request, and `switch_mode` is not available. Older versions saved all defaults, so many existing users have a stored `false` and stay on the modes profile. Decision (user, 2026-11-19): leave them off, with no migration and no prompt; the release notes say how to turn Cordis on.
- **Dispatch failures:** before 4.2.84, one pre-stream failure stopped a Cordis task on Anthropic with no cause shown. 4.2.84 keeps the cause and retries; 4.2.85 adds an end-to-end test. Not yet exercised in a live run.
- **Missing completion:** fixed in 4.2.81 and checked live in r3b. A second reply without a tool call still pauses the task by design. `hasUsedToolInTask` is not saved, so after a task is resumed, the first such reply pauses at once until a tool is used again.
- **Lost chat messages:** fixed in 4.2.82 and checked live in r3b. The defect affected every profile, not only Cordis.
- [R-5](../../risks.md) stays open for the dispatch runtime: only Anthropic requests go through dispatch admission. The profile no longer depends on it.
- The Cordis runs wrote proposed ADRs on their own, in the evaluation workspaces (r1, r2, r3b). With the profile on by default, that may add more proposed records than users want.
- In the S2 runs the model also found C-5 without Cordis. The drift benefit of the plan overlay is not shown separately from Architecture context set to Constraints.
