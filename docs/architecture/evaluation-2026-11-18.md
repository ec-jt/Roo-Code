# Evaluation 2026-11-18: architecture context, Cordis profile, overflow recovery

Status: protocol ready, results pending. The user runs the tasks; results are filled in afterwards.

Build under test: **4.2.70** (`v4.2.70-cordis-preview.66`, commit `f1a9733ea`). Reload the editor after installing so this version is active.

This file is evidence for defaults. It is not a record: it defines no IDs and changes no record status. Decisions that follow from it are made in the records it cites (for example a new ADR or an update to [Q-EFF-1](quality.md)).

## 1. Questions

| #   | Question                                                                                                                                          | Default it decides                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Q1  | Does architecture context reduce re-opened decisions and drift without losing prompt-cache reuse?                                                 | `architectureContextMode` (now `off`)                                                   |
| Q2  | Does the Cordis profile (fixed preset, plan overlay, in-task drift amendment) do the same work with fewer turns or tokens than the modes profile? | Whether the Cordis profile stays experimental                                           |
| Q3  | Does pruning and image offload avoid summaries and keep work quality after an overflow?                                                           | `pruneToolResultsOnOverflow`, `offloadImagesOnOverflow` (both now on), prune thresholds |
| Q4  | Does the repeat-call note change the model's approach?                                                                                            | Keep, retune (3/5/8), or remove the note                                                |

Related records: [C-5](constraints.md), [C-6](constraints.md), [Q-REL-2](quality.md), [Q-REL-3](quality.md), [Q-EFF-1](quality.md), [R-3](risks.md), [R-4](risks.md), [R-5](risks.md).

## 2. Fixed conditions (all runs)

- Same workspace: a fresh worktree of this repository at commit `f1a9733ea` for every run, for example `git worktree add --detach ../roo-eval-S1-off f1a9733ea`. Open that folder as the workspace. Remove it after recording results with `git worktree remove --force ../roo-eval-S1-off`. Do not reset or clean the main checkout; it holds untracked files that are not part of the evaluation.
- Same provider profile and model for every run of a scenario. Record both. The Cordis profile has model dispatch admission for Anthropic only ([R-5](risks.md)); use an Anthropic model for S2.
- Same prompt text, pasted verbatim from section 4. Start each run in a new task.
- Auto-approval: same settings for all runs (recommended: read, write, and execute on; follow-up questions off so drift questions reach you).
- **Compact on context overflow**: on (required for S3).
- Answer model questions with the scripted replies in section 4 where given; otherwise answer briefly and note it in the run log.
- Do not edit `docs/architecture/` by hand during a run.

## 3. Runs per scenario

| Scenario                | Run                    | Settings that differ                                                                             |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| S1 architecture context | S1-off                 | `architectureContextMode` = Off                                                                  |
|                         | S1-index               | Index                                                                                            |
|                         | S1-constraints         | Constraints                                                                                      |
|                         | S1-full                | Full                                                                                             |
| S2 profile              | S2-modes               | Experiment **Cordis runtime preview** off; start in Architect mode, switch to Code when Roo asks |
|                         | S2-cordis              | Experiment on; start in Code mode; send the prompt with `/plan`                                  |
| S3 overflow recovery    | S3-none                | Prune off, offload off                                                                           |
|                         | S3-prune               | Prune on, offload off                                                                            |
|                         | S3-both                | Prune on, offload on                                                                             |
| S4 repeat-call          | (observed in all runs) | none                                                                                             |

For S1 and S3 use the modes profile (experiment off). For S2 use architecture context **Constraints** in both runs.

If budget allows, repeat each run once (two samples per run). Model output varies; a single run per setting is weak evidence.

## 4. Scenarios and prompts

### S1: multi-file change under constraints (Q1, Q4)

Prompt:

> Add an optional `lastOpenedAt` timestamp to task history items. Set it when a task is opened or resumed, show it in the history list tooltip, and add tests. Keep stored tasks compatible.

Scripted replies:

- At about turn 10, send: _"Also convert all existing history items on startup so every item has lastOpenedAt."_ This conflicts with [C-5](constraints.md) (no task-data migration). Expected: the model reports drift and does not write a migration.
- If the model asks to switch to Architect for drift, answer _"Continue with a recorded override: do not migrate, default missing values to undefined."_

Stop when the model calls `attempt_completion` or after 60 API requests.

### S2: planned feature (Q2)

Prompt (S2-cordis: prefix with `/plan `):

> Add a setting that limits how many subtasks a task may create. Default unlimited. Show it in Settings > Context management, persist it, enforce it in new_task, and add tests.

Scripted replies:

- When a plan is presented (`exit_plan` review in S2-cordis, plan text in S2-modes): approve once without changes.
- Same drift message as S1 at about turn 10, adapted: _"Also store the limit inside every existing task's history item."_

Stop when the model calls `attempt_completion` or after 60 API requests.

### S3: forced overflow (Q3)

Use a model or profile with a small context window (for example 32k to 64k tokens) so overflow happens within the run. Record the window.

Prompt:

> Investigate why the webview test TruncationFallback.spec.tsx fails. Run the webview test suite for src/components/chat with full output, take a browser screenshot of the settings page, read the failing component and its test, then fix the test and run it again.

The full test output and the screenshot create large tool results and images. Stop after the first successful test run, after `attempt_completion`, or after 60 API requests.

## 5. Metrics and where to read them

Record every metric from the chat UI and the provider's usage view. Do not read stored task files.

| Metric                     | Where                           | How                                                                                                                                                      |
| -------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API requests               | Chat                            | Count **API Request** rows                                                                                                                               |
| Tokens in / out            | Task header                     | Totals at the end of the run                                                                                                                             |
| Cache reads / writes       | Task header (or provider usage) | Totals at the end of the run                                                                                                                             |
| Cache hit rate             | Computed                        | cache reads / (cache reads + cache writes + uncached input tokens)                                                                                       |
| Cost                       | Task header                     | Total at the end                                                                                                                                         |
| Overflow events            | Chat                            | Count **Tool Results Pruned**, **Context Condensed**, and **Context Truncated** rows separately                                                          |
| Summaries avoided          | Chat                            | Number of **Tool Results Pruned** rows (prune or offload only, no summary)                                                                               |
| Images offloaded           | Chat                            | Sum of "Saved N older images" in prune rows                                                                                                              |
| Recovery failures          | Chat                            | Errors after overflow (second overflow, "compact manually")                                                                                              |
| Re-opened decisions        | Chat, manual                    | Times the model revisits a choice it or you already settled (for example re-proposes a migration, re-asks an answered question)                          |
| Repeated failed approaches | Chat, manual                    | Times the model retries an approach that already failed in the same run                                                                                  |
| Drift handling             | Chat, manual                    | One of: **reported** (stopped, cited ID, asked or amended), **ignored** (implemented the conflicting change), **silent** (avoided it without saying why) |
| Repeat-call notes          | Chat, manual                    | Count tool results with "with identical arguments"; for each, did the next call change approach? (yes/no)                                                |
| Plan reviews (S2)          | Chat                            | Count **Plan for review** rows and **Keep planning** responses                                                                                           |
| Outcome                    | Workspace                       | Tests pass (yes/no), task completed (yes/no), reviewer judgment of the diff (good / acceptable / poor)                                                   |

## 6. Decision rules

Rules are applied to the mean over samples. "Better" means at least 10 percent better; smaller differences count as equal.

**Q1, architecture context default**

1. If Index or Constraints has fewer re-opened decisions or better drift handling than Off, and its cache hit rate is no more than 5 points lower than Off: make the better of the two the default.
2. If both are equal to Off on decisions and drift: keep Off.
3. Full becomes default only if it beats Constraints on decisions and drift and costs no more than 15 percent more tokens than Constraints. Otherwise Full stays opt-in.

**Q2, Cordis profile**

1. If S2-cordis has fewer or equal API requests and tokens than S2-modes, equal or better outcome, and drift reported: propose an ADR to keep the profile and widen the experiment.
2. If it is worse on outcome or drift: record the failure in [R-5](risks.md) or a new risk and keep it experimental.

**Q3, overflow recovery**

1. If S3-both and S3-prune avoid at least one summary that S3-none needed, with no recovery failure and equal outcome: keep both on.
2. If offload gives no benefit over prune-only (same number of summaries and tokens): keep it on, since it only runs during overflow, but record that it was not exercised.
3. If pruning causes a worse outcome (for example the model re-runs commands to recover pruned output more than twice): raise the prune threshold (8192 characters) or the head size (4096) and note it in [R-3](risks.md).

**Q4, repeat-call note**

1. If at least half of the notes are followed by a changed approach: keep 3/5/8.
2. If notes never appear: keep, no evidence either way.
3. If notes appear but rarely change behaviour: move the first threshold to 2 or reword the note, then re-run S1 only.

## 7. Results

Fill in one row per run. Leave cells blank if not measured.

### S1

| Run            | Model | Requests | Tokens in / out | Cache read / write | Hit rate | Cost | Re-opened decisions | Repeated failures | Drift handling | Repeat notes (changed) | Outcome |
| -------------- | ----- | -------- | --------------- | ------------------ | -------- | ---- | ------------------- | ----------------- | -------------- | ---------------------- | ------- |
| S1-off         |       |          |                 |                    |          |      |                     |                   |                |                        |         |
| S1-index       |       |          |                 |                    |          |      |                     |                   |                |                        |         |
| S1-constraints |       |          |                 |                    |          |      |                     |                   |                |                        |         |
| S1-full        |       |          |                 |                    |          |      |                     |                   |                |                        |         |

### S2

| Run       | Model | Requests | Tokens in / out | Cache read / write | Hit rate | Cost | Plan reviews (keep planning) | Re-opened decisions | Drift handling | Outcome |
| --------- | ----- | -------- | --------------- | ------------------ | -------- | ---- | ---------------------------- | ------------------- | -------------- | ------- |
| S2-modes  |       |          |                 |                    |          |      |                              |                     |                |         |
| S2-cordis |       |          |                 |                    |          |      |                              |                     |                |         |

### S3

| Run      | Model / window | Requests | Tokens in / out | Pruned rows | Condensed rows | Truncated rows | Images offloaded | Recovery failures | Repeated failures | Outcome |
| -------- | -------------- | -------- | --------------- | ----------- | -------------- | -------------- | ---------------- | ----------------- | ----------------- | ------- |
| S3-none  |                |          |                 |             |                |                |                  |                   |                   |         |
| S3-prune |                |          |                 |             |                |                |                  |                   |                   |         |
| S3-both  |                |          |                 |             |                |                |                  |                   |                   |         |

### Run log

Free-text notes per run: unexpected questions, manual answers given, crashes, anything that makes a run not comparable.

## 8. Conclusions

To be written after the results are in, applying section 6. List each default change with the rule that justifies it, and the record to update (new ADR, [Q-EFF-1](quality.md) measure, or risk).
