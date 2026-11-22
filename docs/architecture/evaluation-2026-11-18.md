# Evaluation 2026-11-18: architecture context, Cordis profile, overflow recovery

Status: protocol ready, results pending. The user runs the tasks; results are filled in afterwards.

Build under test: **4.2.76** (`v4.2.76-cordis-preview.72`, commit `b2957a36d`). Install `bin/roo-cline-4.2.76.vsix` and reload the editor so this version is active. Check the version in the Extensions view before the first run, and disable any other Roo build (for example the nightly) so only 4.2.76 is active.

The workspace under test (the code the model edits) stays at commit `9deda9b58` for every run, as in section 2. The installed extension, not the worktree, decides which Roo version runs.

Host: macOS. Main checkout: `/Users/jamestrappett/Documents/Roo-Code`. Worktrees are created next to it in `/Users/jamestrappett/Documents/`.

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

- Same workspace: a fresh worktree of this repository at commit `9deda9b58` for every run. Replace `S1-off` with the run name:

    ```bash
    cd /Users/jamestrappett/Documents/Roo-Code
    git worktree add --detach ../roo-eval-S1-off 9deda9b58
    cd ../roo-eval-S1-off
    rm docs/architecture/evaluation-2026-11-18.md
    pnpm install --frozen-lockfile --prefer-offline
    ```

    Delete this protocol from the worktree (as the `rm` line above does). If you leave it, the model can read the scripted drift messages and the expected answers. Open `/Users/jamestrappett/Documents/roo-eval-S1-off` as the workspace folder. Remove it after recording results:

    ```bash
    cd /Users/jamestrappett/Documents/Roo-Code && git worktree remove --force ../roo-eval-S1-off
    ```

    Do not reset or clean the main checkout; it holds untracked files that are not part of the evaluation.

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

S1 and S3 runs were done once (one sample). Section 3 recommends two samples, so the conclusions for Q1, Q3 and Q4 are provisional. S2 has four samples (r1, r2, r3, r3b). Three of them are fully valid; see the S2 notes below.

**Setup:**

- Runs were done on 2026-11-18 and 2026-11-19.
- Model: Anthropic `claude-opus-5-5` (profile "opus", medium reasoning).
- Builds: S1 and S2 sample 1 ran on 4.2.78. S2 sample 2, the valid S3 rerun and S3P ran on 4.2.80. S2 sample 3 ran on 4.2.81, and sample 3b on 4.2.82.
- Each run used a fresh copy of a standalone snapshot of `9deda9b58`, with one commit, no history and no copy of this protocol. A search of each snapshot found no scripted text.
- The operator was a separate Roo subtask that used `computer_action`.
- Metrics come from the task files `ui_messages.json` and `api_conversation_history.json`, which section 5 says not to read. Only the request counts and token totals were cross-checked against the chat UI. All the drift-message counts below are by request number.

Hit rate in these tables is cache reads divided by tokens in.

### S1

| Run            | Model           | Requests | Tokens in / out    | Cache read / write  | Hit rate | Cost  | Re-opened decisions | Repeated failures | Drift handling                       | Repeat notes (changed) | Outcome                                             |
| -------------- | --------------- | -------- | ------------------ | ------------------- | -------- | ----- | ------------------- | ----------------- | ------------------------------------ | ---------------------- | --------------------------------------------------- |
| S1-off         | claude-opus-5-5 | 25       | 1,886,486 / 20,961 | 1,772,803 / 113,583 | 94.0%    | $0.93 | 0                   | 0                 | reported (C-5, Q-REL-1 at req 11)    | 0                      | completed; focused tests pass; diff good (+164/-20) |
| S1-index       | claude-opus-5-5 | 23       | 1,629,390 / 15,647 | 1,527,888 / 101,410 | 93.8%    | $0.82 | 0                   | 0                 | reported (C-5 at req 6, drift at 11) | 0                      | completed; focused tests pass; diff good (+116/-2)  |
| S1-constraints | claude-opus-5-5 | 23       | 1,775,957 / 22,242 | 1,670,081 / 105,784 | 94.0%    | $0.87 | 0                   | 0                 | reported (C-5, Q-REL-1 at req 14)    | 0                      | completed; focused tests pass; diff good (+132/-2)  |
| S1-full        | claude-opus-5-5 | 26       | 1,972,101 / 17,828 | 1,864,690 / 107,307 | 94.6%    | $0.92 | 0                   | 0                 | reported (C-5, Q-REL-1 at req 11)    | 0                      | completed; focused tests pass; diff good (+119/-2)  |

### S2

| Run           | Model           | Requests | Tokens in / out    | Cache read / write  | Hit rate | Cost  | Plan reviews (keep planning)                     | Re-opened decisions | Drift handling                                                 | Outcome                                                                                                             |
| ------------- | --------------- | -------- | ------------------ | ------------------- | -------- | ----- | ------------------------------------------------ | ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| S2-modes      | claude-opus-5-5 | 42       | 5,430,345 / 52,601 | 5,136,134 / 294,043 | 94.6%    | $2.50 | 1 (0)                                            | 0                   | reported (C-5 at req 13)                                       | completed; focused tests pass; diff good (+330/-18, 4 new files)                                                    |
| S2-cordis     | claude-opus-5-5 | 34       | 3,258,515 / 29,257 | 3,052,453 / 205,926 | 93.7%    | $1.65 | 2 (0)                                            | 0                   | reported (C-5, Q-REL-1 amendment at req 12; proposed ADR)      | completed; focused tests pass; diff good (+371/-18, 3 new files)                                                    |
| S2-modes-r2   | claude-opus-5-5 | 50       | 6,584,166 / 40,482 | 6,275,104 / 308,862 | 95.3%    | $2.81 | 1 (0); mode switch at req 16                     | 0                   | reported (C-5 follow-up at req 11)                             | completed; tests and type checks pass; diff good                                                                    |
| S2-cordis-r2  | claude-opus-5-5 | 30       | 2,684,827 / 34,152 | 2,492,267 / 192,440 | 92.8%    | $1.47 | 2 (0)                                            | 0                   | reported (C-5, Q-REL-1, R-2 amendment at req 14; proposed ADR) | finished with text only, then `resume_task` (no `attempt_completion`); new tests pass; diff acceptable              |
| S2-modes-r3   | claude-opus-5-5 | 33       | 3,674,800 / 35,766 | 3,424,366 / 250,302 | 93.2%    | $1.94 | 1 (0); mode switch at req 8                      | 0                   | reported (C-5, Q-REL-1 follow-up at req 12)                    | completed; focused tests and type checks pass; diff good                                                            |
| S2-cordis-r3  | claude-opus-5-5 | 28       | 2,544,714 / 24,445 | 2,335,831 / 208,771 | 91.8%    | $1.52 | 1 (0)                                            | 0                   | not rateable: the drift message was lost (product defect)      | completed; focused tests pass; diff good                                                                            |
| S2-modes-r3b  | claude-opus-5-5 | 48       | 5,551,887 / 49,607 | 5,224,275 / 327,420 | 94.1%    | $2.69 | 0 (0); plan in a follow-up; mode switch at req 9 | 0                   | reported (C-5, Q-REL-1 follow-up at req 14)                    | completed; focused tests and type checks pass; diff good                                                            |
| S2-cordis-r3b | claude-opus-5-5 | 35       | 3,511,983 / 35,939 | 3,287,123 / 224,720 | 93.6%    | $1.79 | 2 (0)                                            | 0                   | reported (C-5, Q-REL-1 amendment at req 14; proposed ADR)      | completed after one tool reminder (req 34 text-only, `attempt_completion` at req 35); focused tests pass; diff good |

- The second sample (`-r2`) ran on 4.2.80 with the same prompts and scripted replies.
- The third sample (`-r3`) ran on 4.2.81. S2-cordis-r3 is valid for cost and outcome but not for drift, because its drift message never reached the task.
- Sample 3b (`-r3b`) ran on 4.2.82 and repeats the pair after both fixes. Its modes cost is probably too high (see the run log).

### S3

These are the valid rerun on 4.2.80. The first attempt, on 4.2.79, is in the run log.

| Run      | Model / window                      | Requests | Tokens in / out | Pruned rows | Condensed rows | Truncated rows | Images offloaded | Recovery failures | Repeated failures | Outcome                                 |
| -------- | ----------------------------------- | -------- | --------------- | ----------- | -------------- | -------------- | ---------------- | ----------------- | ----------------- | --------------------------------------- |
| S3-none  | claude-opus-5-5 / 64,000 (override) | 14       | 651,973 / 5,908 | 0           | 2              | 0              | 0                | 0                 | 1                 | completed; spec passes; diff good       |
| S3-prune | claude-opus-5-5 / 64,000 (override) | 10       | 453,023 / 4,541 | 0           | 2              | 0              | 0                | 0                 | 0                 | completed; spec passes; diff good       |
| S3-both  | claude-opus-5-5 / 64,000 (override) | 15       | 704,177 / 5,706 | 0           | 2              | 0              | 0                | 0                 | 0                 | completed; spec passes; diff acceptable |

### S3P: pruning scenario (added after S3)

S3 never pruned, so this scenario forces large tool results early. The task reads three large chat components in full, about 69, 57 and 47 KB. It then writes a report and runs one test. Offload was off in both runs.

| Run       | Model / window                      | Requests | Tokens in / out | Cost  | Pruned rows | Condensed rows | Truncated rows | Re-reads of pruned files | Recovery failures | Outcome                                      |
| --------- | ----------------------------------- | -------- | --------------- | ----- | ----------- | -------------- | -------------- | ------------------------ | ----------------- | -------------------------------------------- |
| S3P-none  | claude-opus-5-5 / 64,000 (override) | 8        | 455,946 / 5,179 | $0.90 | 0           | 3              | 0              | not applicable           | 0                 | completed; test 47/47; report accurate; good |
| S3P-prune | claude-opus-5-5 / 64,000 (override) | 9        | 504,285 / 7,955 | $0.92 | 2           | 2              | 0              | 0                        | 0                 | completed; test 47/47; report accurate; good |

**S3P-prune:**

- At req 3, pruning one tool result cut the context from 78,967 to 21,938 tokens, with no summary.
- At req 6, a second prune cut it from 65,009 to 37,689 tokens.
- The two summaries cost $0.15 in S3P-prune, against $0.61 for the three summaries in S3P-none.
- The model did not re-read a pruned file with `read_file`. It checked line numbers once with a shell command.

### Run log

**S1-off, attempts 1 and 2: invalid.**

- **Attempt 1 (4.2.76):** the queued drift message reached the model inside a `read_file` tool result. The model treated it as possible prompt injection.
    - The cause was a regression from `8de9337e6`: approval feedback was embedded as bare JSON in the tool result.
    - 4.2.77 fixed it: user text now goes in a separate `<user_message>` block after the tool result.
- **Attempt 2 (4.2.77):** the model ran `git diff -- docs/architecture/` and saw this protocol in the worktree diff, including the scripted drift messages.
    - From then on, every run used the orphan snapshot. The table above shows run 3.

**All S1 runs:** before any drift message, the model already stopped on the base prompt. Setting `lastOpenedAt` on open rewrites `history_item.json`, which conflicts with C-5 and Q-REL-1, and the model asked about it. The scripted override was given each time.

- S1-off, constraints and full stopped at the drift message.
- S1-index stopped twice: once at req 6 (before the drift message) and again at req 11.

**S1-full:** the context block was 5,066 characters, identical to S1-constraints. Full mode adds accepted decisions and risks only when their `Paths` match a file read. In this snapshot, the only accepted ADR has `Paths: docs/architecture/**`, and the R-1 to R-5 risks have Status "proposed", so nothing extra was added.

**S2-modes:**

- At req 5, Roo asked how to count subtasks. Manual answer: "Count each task's direct children only."
- The plan was approved at req 8.
- The switch to Code was auto-approved at req 9 (`alwaysAllowModeSwitch` was on).

**S2-cordis:**

- The plan review was approved at req 6.
- The drift arrived as a second `plan_review` (an amendment) with no text field. I clicked "Approve plan" and also sent the scripted reply as a chat message.
- The model wrote `docs/architecture/decisions/proposed/ADR-2026-11-18-per-task-subtask-limit.md`.

**S3, first attempt (4.2.79): invalid.**

- In all three runs, the first compaction ended with "The retry after context compaction returned no response."
- **Cause:** `Task.attemptApiRequest()` counted only `text` and `tool_call` chunks as a response. Anthropic, Bedrock, OpenRouter, Gemini and others emit `tool_call_partial`, so a reply with reasoning plus a tool call was rejected.
- This bug had been present since 4.2.23. The 64k override made compaction frequent enough to expose it.
- Fixed in 4.2.80.

**S3 rerun (4.2.80):**

- **Context window:** opus has a 1M-token window. The new per-profile `modelContextWindowOverride` (4.2.79) set it to 64,000 for these runs. Compaction happened at about 51k to 53k tokens.
- **Prune and offload never triggered:** every overflow went straight to a summary. In the invalid first attempt, one prune happened (S3-prune, req 6), and a summary followed it anyway.
- **Browser screenshot:** the browser screenshot of the settings page was blank in every run, because navigation timed out. So no images were offloaded.
- **S3-none:** the repeated failure was a rerun of the full chat suite, done to confirm a `ChatView.spec.tsx` failure. That failure is not related to the task and is present in every S3 workspace.
- **S3-both:** rated acceptable, not good:
    - It left `screenshots/webview-settings-attempt.png` in the workspace.
    - It used `tail -150`, although the prompt asked for full output.
- **Manual action:** in S3-none, I clicked "Run" (proceed while running) once, when a Vite dev server command blocked the task.

**S2 second sample (4.2.80):**

- **S2-modes-r2:** Roo asked the same subtask-counting question as sample 1, at req 7, and got the same answer. The drift message was sent at req 10 and handled at req 11. The plan was approved at req 15, and the mode switched at req 16.
- **S2-cordis-r2:**
    - Plan approved at req 5.
    - Drift message sent at req 11, one request late, because the poll first saw the count at 11.
    - The drift amendment was approved at req 14. The scripted reply was then sent as a chat message.
    - The run ended with a text summary and no `attempt_completion`, so Roo showed `resume_task`. Its new tests pass. It reports 12 `ClineProvider.spec.ts` failures and says they also fail without its change. It wrote a proposed ADR in the workspace.
- **Both runs:** the drift message arrived in a `<user_message>` block, with no leaks. Grepping the added lines found no migration, only comments that say "never migrated".

**S3P (4.2.80):** neither run overflowed on a single read. Neither run has a Context Truncated row.

**S2-cordis-r2 ending, investigated after sample 2:**

- The run did not stop because of model variance alone. With Cordis on, `Task.makeClineRequests()` treated any reply without a tool call as the end of the turn and asked `resume_task`. It never sent the "use a tool" reminder that the modes profile sends. This branch had existed since 4.2.5.
- **4.2.81** added the setting `cordisTextOnlyTurnPolicy`. The default `retryThenPause` sends one reminder once the task has used a tool, and pauses only if the next reply also has no tool call. `alwaysPause` keeps the old behaviour.

**S2 third sample (4.2.81):**

- **S2-modes-r3:** the counting question came at req 6 and the plan at req 7. The switch to Code came at req 8. The drift message was sent at req 10 and reported at req 12. At req 32 the run replied with text only; the standard reminder followed and it completed at req 33.
- **S2-cordis-r3:** the plan was approved at req 9. The drift message was typed and sent at req 10, about 6 s after an auto-approved to-do update, during a 2.7 s checkpoint save. It never reached the task: no `user_feedback` row, nothing in the API history. The run completed with no text-only reply, so the 4.2.81 retry did not run.
- **Cause of the lost message:** the chat view treated an auto-approved tool ask as still waiting (it ignored `isAnswered`). It sent the text as an answer instead of queuing it. The extension stored it with no ask waiting, and the next ask cleared it. The defect is not specific to Cordis; the 2.7 s checkpoint made the window large enough to hit.
- **4.2.82** queues a message that arrives when no ask is waiting, and the chat view queues text typed after an answered approval ask.

**S2 sample 3b (4.2.82):**

- Each drift message was checked with a screenshot within 2 s and then in the task files: the input cleared, a "Queued Messages" row showed, and a `user_feedback` row followed within 2 s. Both runs got the drift message at req 12 (the poll skipped req 10). The pair stays matched.
- **S2-modes-r3b:** the counting question and the plan came as one follow-up. The run waited about 37 minutes at it (network loss, and the user was using the computer), so the prompt cache probably expired; its cost is probably too high. It asked one extra follow-up about translations at req 42, answered with its own first suggestion.
- **S2-cordis-r3b:** the drift came as an amendment at req 14. I approved it and sent the override as a chat message; the override was queued and delivered about 7 s later. At req 34 the run replied with text only. The 4.2.81 reminder followed, and it called `attempt_completion` at req 35. It wrote a proposed ADR in its workspace, and its own reasoning noted that Code mode should not edit `docs/architecture/`.
- **Both runs:** every user message arrived in a `<user_message>` block. No migration in the added lines.

**S2 on 4.2.83, attempt (invalid):**

- Planned as two pairs on DeepSeek (`deepseek-flash`) and Opus. Only S2-modes-ds ran fully: 60 requests, only file reads, no plan, no question, drift not reported (its reasoning noted C-5). Cost $0.18.
- S2-cordis-ds reached a `plan_review` with a sound plan. Its drift message was never sent: turning Cordis on attached the dispatch runtime to the operator's own Anthropic task, a request failed before streaming, and the task stopped with a bare `dispatch-failed`.
- **Cause:** `dispatchError()` dropped the original error, and the Cordis path skipped the ordinary first-chunk retry. Fixed in 4.2.84.
- **Operator lesson:** the Cordis setting is global. Start the operator with Cordis off, switch it on once before the Cordis runs, and never switch it off during a session.

**S2 sample 5 (4.2.84), DeepSeek and Opus:**

| Run            | Model           | Requests | Tokens in | Cost  | Plan reviews | Drift handling                                     | Outcome                                                                 |
| -------------- | --------------- | -------- | --------- | ----- | ------------ | -------------------------------------------------- | ----------------------------------------------------------------------- |
| S2-modes-ds    | deepseek-flash  | 60       | 8.31M     | $0.21 | 0            | reported (follow-up citing C-5 at req 19)          | stopped at the 60-request limit while writing tests; acceptable         |
| S2-modes-opus  | claude-opus-5-5 | 39       | 3.81M     | $1.86 | 0            | reported (follow-up citing C-5 at req 13)          | completed; new tests pass; good                                         |
| S2-cordis-ds   | deepseek-flash  | 61       | 5.73M     | $0.12 | 1            | reported in text, then built into the plan         | stopped at the 60-request limit while presenting its result; acceptable |
| S2-cordis-opus | claude-opus-5-5 | 46       | 5.37M     | $2.31 | 2            | reported (amendment citing C-5, Q-REL-1 at req 15) | completed after one tool reminder; new tests pass; good                 |

- The drift message reached every run within 10 s, inside `<user_message>`. No run migrated task data.
- **S2-cordis-ds:** three `task_state` calls failed schema validation (`expected_revision` missing, `operations: ""`), which raised `mistake_limit_reached` at req 16. The operator answered that prompt with the override. Fixed in 4.2.85.
- **S2-cordis-opus:** one reply without a tool call, one reminder, then `attempt_completion` (the 4.2.81 path again).
- No `dispatch-failed` occurred in any run, so the 4.2.84 retry was not exercised live. 4.2.85 adds an end-to-end test with an injected 529.
- DeepSeek costs 9 to 19 times less per run but takes many small steps. Both DeepSeek runs reached the 60-request limit of this protocol, which is not a product limit.

## 8. Conclusions

- **Q1 and Q4:** answered from one sample per run.
- **Q2:** answered from five Opus samples (r1, r2, r3, r3b, r5) and one DeepSeek sample (r5).
- **Q3:** answered from S3 plus the S3P scenario that was added to it.

**Q1, architecture context default: keep `off` (rule 2). Full stays opt-in (rule 3).**

- Index and Constraints were equal to Off on both measures:
    - re-opened decisions: 0 in every run;
    - drift handling: reported in every run, including Off.
- The model found C-5 without injected context, by reading `docs/architecture/` itself.
- Hit rates were 93.8% to 94.6%, within 1 point of each other.
- Full did not beat Constraints: its context block was the same.
- **Limit:** this repository's records are easy to find, so Off performs well here. In a repository where the model does not look for `docs/architecture/`, the result may differ.
- **Record:** no change. `architectureContextMode` stays `off` by default.

**Q2, Cordis profile: rule 1 is met overall. Cordis was cheaper in four of five Opus samples, and on 4.2.82 and later the outcome is equal.**

| Measure      | Cordis r1 | Modes r1 | Cordis r2 | Modes r2 | Cordis r3 | Modes r3 | Cordis r3b | Modes r3b | Change with Cordis (all four) |
| ------------ | --------- | -------- | --------- | -------- | --------- | -------- | ---------- | --------- | ----------------------------- |
| API requests | 34        | 42       | 30        | 50       | 28        | 33       | 35         | 48        | 27% fewer (127 vs 173)        |
| Input tokens | 3.26M     | 5.43M    | 2.68M     | 6.58M    | 2.54M     | 3.67M    | 3.51M      | 5.55M     | 44% fewer (12.0M vs 21.2M)    |
| Cost         | $1.65     | $2.50    | $1.47     | $2.81    | $1.52     | $1.94    | $1.79      | $2.69     | 35% lower ($6.43 vs $9.94)    |

- Leaving out r3 (Cordis drift not rateable) gives 29% fewer requests, 46% fewer input tokens and 39% lower cost. Leaving out r3b as well (modes cost inflated by the long wait) still leaves Cordis cheaper in r1 and r2.
- **r5 (4.2.84):** Cordis cost more than modes on Opus ($2.31 vs $1.86, 46 vs 39 requests). It is the first sample where Cordis did not save. Over all five Opus samples, Cordis used 18% fewer requests (173 vs 212) and 31% fewer input tokens (17.4M vs 25.0M), and cost 26% less ($8.74 vs $11.80). The saving is smaller than the four-sample figure and varies by run.
- **DeepSeek (r5, one pair):** both arms reported drift and reached the request limit. Cordis on DeepSeek ran `/plan`, `exit_plan` and `plan_review` without the dispatch runtime, as designed. One pair is not enough to measure a saving.
- **Drift:** reported with no migration in every run where the message arrived (7 of 8).
- **Outcome:**
    - r1: equal (both good).
    - r2: Cordis ended without `attempt_completion`. Investigation showed a Cordis code path, not only model variance. Fixed in 4.2.81.
    - r3: both completed and both diffs good, but the Cordis drift message was lost to a product defect (not specific to Cordis). Fixed in 4.2.82.
    - r3b (4.2.82): equal. Both completed with good diffs. The Cordis run hit a reply without a tool call, got one reminder, and completed.
    - r5 (4.2.84): equal on Opus (both good). On DeepSeek both arms were cut off by the request limit (both acceptable).
- **Record:** accepted [ADR-2026-11-19-keep-cordis-profile-widen-experiment](decisions/accepted/ADR-2026-11-19-keep-cordis-profile-widen-experiment.md). It:
    - keeps the profile;
    - turns the profile on by default for all providers, now that the samples agree (the user chose all providers over Anthropic only);
    - keeps [R-5](risks.md) open for the dispatch runtime, which stays Anthropic-only;
    - recommends one S2 pair on a non-Anthropic model, because every sample used Anthropic (done in r5 with DeepSeek: Cordis works there, cost not yet measurable);
    - keeps users with a stored `cordisRuntimePreview: false` off. Older versions saved all defaults, so many existing users keep the modes profile. The user decided not to migrate or prompt; the release notes say how to turn Cordis on.
    - records the missing-completion risk as fixed in 4.2.81 and checked live in r3b.

**Q3, overflow recovery: keep `pruneToolResultsOnOverflow` on (rule 1 is met by S3P). Keep `offloadImagesOnOverflow` on (now exercised live, see the 4.2.85 checks). Rule 3 does not apply.**

- **S3:** no run avoided a summary. There were 0 recovery failures after the 4.2.80 fix.
- **S3P:** S3P-prune avoided one of the three summaries that S3P-none needed (2 summaries instead of 3).
    - Its first overflow was handled by pruning alone.
    - It had 0 recovery failures and the same outcome (both good).
    - It did not re-read the pruned files with `read_file`.
    - Summary cost was $0.15 vs $0.61. Total cost was about the same ($0.92 vs $0.90).
- **Offload:** exercised once, in live check C3 on 4.2.85 (`opus-64k`). Three images read with `read_file` were replaced by `[Image offloaded: ...]` placeholders and saved as PNG files. Offload alone did not bring the context under budget, so condense still ran twice (83,668 → 76,139 → 75,854 tokens). The model then said it could not see the image instead of guessing. The offload count was not shown when condense followed; fixed in 4.2.86.
- **Record:** update the notes in [Q-EFF-1](quality.md) and [R-3](risks.md). Pruning and offload are now both verified in a live run.

**Q4, repeat-call note: keep 3/5/8 (rule 2).**

- No "with identical arguments" note appeared in any of the 16 valid runs (S2-cordis-r3 included, since this measure does not depend on drift).
- **Record:** no change.

**Defect found and fixed during the evaluation**

These came from running the evaluation, not from the questions above:

- **4.2.77:** queued user messages reach the model as user messages.
- **4.2.80:** a reply with only a tool call is accepted after compaction.
- **4.2.81:** with Cordis on, a reply without a tool call gets one reminder before the task pauses (setting `cordisTextOnlyTurnPolicy`, default `retryThenPause`).
- **4.2.82:** a chat message sent while no ask is waiting is queued instead of silently lost.
- **4.2.83:** Cordis is on by default for all providers (the accepted ADR).
- **4.2.84:** a Cordis dispatch failure keeps the real error (status and message) and a pre-stream `dispatch-failed` is retried like the modes profile.
- **4.2.85:** `task_state` and `memory` accept empty or missing `expected_revision` and `operations` on read; a write without a revision returns guidance instead of a schema failure. The plan review has a text field whose text reaches the model as a `<user_message>` after the tool result.
- **4.2.86:** the string `"null"` counts as null in `task_state` and `memory` arguments; the user can enable task state at any time, including before the first model turn or while an ask is pending; a disabled `task_state` call says how to enable it; condense and truncation rows show how many tool results were pruned and images offloaded.
- **4.2.87 and 4.2.88:** see the live-check sections below.
- **4.2.89:** after a summary, recovery also shortens oversized tool results in the kept messages and refuses to send a prompt that still exceeds the window.
- **4.2.90:** for profiles with a context window override, the check before sending estimates the pending request (last usage plus the tool results added since) instead of using the last request's usage alone. Models without an override are unchanged (C-6). The prune note now reads "Shortened N large tool results".
- **4.2.91:** when the first large tool batch overflows and there is no earlier history to summarize, recovery shortens the latest tool results and retries once, instead of stopping with "Not enough earlier history to compact".
- **4.2.92:** a request sent after recovery records its own provider start time. A provider rejection for size shows a "Context too large" warning row before recovery. A recovery error appears once instead of twice.

**Live checks on 4.2.85 (2026-11-19):**

| Check                                        | Task       | Result | Evidence                                                                                                                                                                            |
| -------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1: plan review text field, `deepseek-flash` | `01a1f5c0` | pass   | The turn after `exit_plan` held `[tool_result (status JSON only), <user_message>Use the name --silent...</user_message>, environment_details]`; the model used `--silent`.          |
| C1: `task_state`, `deepseek-flash`           | `01a1f5c0` | fail   | First call `{"action":"read","operations":"null"}` failed schema validation; the second returned `DISABLED`. Enabling during the task failed. Both fixed in 4.2.86.                 |
| C2: real pre-stream 529, Cordis on Anthropic | `01a1f5ba` | pass   | A local fault proxy returned two 529s. Two `api_req_retry_delayed` rows showed `dispatch-failed (529 overloaded_error: Overloaded)`; the task retried and completed; no key leaked. |
| C3: image offload, `opus-64k`                | `01a1f5bd` | pass   | 3 images offloaded to PNG files, then condense; the model said it could not see the image.                                                                                          |

**Live checks on 4.2.86 (2026-11-19):**

| Check                                        | Task       | Result                        | Evidence                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ---------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1: enable task state during the first turn  | `01a1f5e2` | pass (enable), fail (patches) | The user enabled task state while request 1 ran; revision 1 was written. A later `read` returned a revision. All 6 model patches failed with the generic schema error (record wrapped as `record:{...}` or flat, no `expected_revision`); one `mistake_limit_reached`. |
| L2: DeepSeek sends the string `"null"`       | `01a1f5e2` | not exercised                 | DeepSeek sent a JSON `null` in this run. Covered by unit tests only.                                                                                                                                                                                                   |
| L3: offload count after condense, `opus-64k` | `01a1f5f2` | pass (data), fail (UI)        | The `context_pruned` row had `prunedCount: 1, offloadedCount: 3` (83,665 → 23,495 tokens). The chat window copy step dropped `contextPrune` and the counts, so the UI showed no prune row.                                                                             |

- **4.2.87:** `task_state` patch operations are no longer checked in the parser. The tool renames `record` to `value` and moves flat record fields into `value`, then validates. A patch without a revision still returns `REVISION_REQUIRED` first. An invalid operation returns `INVALID_OPERATIONS` with its index, the failing field and a complete example. The tool description shows one exact patch call. The chat window now passes `contextPrune` and the prune and offload counts to the webview.

**Live checks on 4.2.87 (2026-11-19):**

| Check                                   | Task       | Result                 | Evidence                                                                                                                                                                                                    |
| --------------------------------------- | ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1: DeepSeek `task_state` patch         | `01a1f60e` | pass                   | One `set` used `collection` instead of `field` and got `INVALID_OPERATIONS ... invalid at field`; the model corrected it and the patch succeeded (ledger revision 2 written by the model).                  |
| M1: DeepSeek read                       | `01a1f60e` | fail                   | Three reads failed with the generic schema error and reached `mistake_limit_reached`. The stored input `{"operations":"null"}` was lossy; the real call most likely carried a non-null `expected_revision`. |
| M2: counts on condense rows, `opus-64k` | `01a1f615` | pass (data), fail (UI) | The row had `prunedCount 1, offloadedCount 3`. The summary was longer than the preview limit, so the row rendered as a plain preview without the counts.                                                    |

- **4.2.88:** a `read` ignores `expected_revision` and `operations`. A rejected call keeps the exact arguments the model sent (`rawInput`) in the API history. The generic schema error names the failing path. Context preview rows show tokens, cost and the prune and offload counts.

**Live checks on 4.2.88 (2026-11-19):**

| Check                                    | Task       | Result | Evidence                                                                                                                                                                                    |
| ---------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1: DeepSeek `task_state` read and patch | `01a1f633` | pass   | Task state enabled while idle. Read returned a revision; three model patches succeeded on the first try (ledger revisions 2, 4, 6 by the model). No generic schema error, no mistake limit. |
| P2: counts on context rows, `opus-64k`   | `01a1f638` | pass   | The prune row showed "Shortened 1 large older tool result" and "Saved 3 older images to the task folder"; each condense preview showed its token line, cost and pruned count.               |

- P1 did not send the bad read shape, so the 4.2.88 read fix is covered by a replay unit test only.
- **Condense that grew the context (r86, r87, r88), fixed in 4.2.89:**
    - **Cause:** recovery kept the newest tool exchange after the summary point verbatim, and prune and offload only covered messages before it. In r88 condense 3 the kept result was a 220,139-character `read_file` of `Task.ts`; the new summary was about 12k characters, so the next request used 139,088 input tokens on a 64k window. r86 (220,139 characters) and r87 (92,961) had the same shape. No check ran after the summary, so the prompt was sent; it only succeeded because the real window was 1M.
    - **Reporting:** the row's "before" value was the last request's usage, which did not include the tool result added since, so the row showed growth that had already happened.
    - **Fix (4.2.89, `manageContext`):** when the estimate after the summary exceeds the budget, recovery shortens tool results in the kept messages (head and tail kept, full text saved) and offloads their images, once each. If the prompt still exceeds the input limit, recovery returns an error with history unchanged instead of sending. The row reports the measured pre-recovery size and the counts include the kept messages. Behaviour is unchanged when no overflow occurs or when the summary already fits.
    - Verified live on 4.2.89 (task `01a1f657`, `opus-64k`): the condense row went from 247,715 to 45,789 tokens with 5 tool results shortened, 3 of them in the kept tail, and the next request used 49,142 input tokens.

**Overflow detection before sending (D1), 4.2.90 and 4.2.91:**

- **4.2.89 run:** the check before sending used the last request's usage, which did not include tool results added since. Two requests went out above 64k without recovery (122,934 and 74,042 input tokens); they succeeded only because the real window was 1M.
- **Decision (user, 2026-11-20):** keep [C-6](constraints.md) and the overflow-only ADR unchanged. Only profiles with a context window override check before sending, because the provider does not enforce the override. Models without an override recover after the provider rejects a request for size, then retry once.
- **Reversed (user, 2026-11-20, later the same day):** "no need to estimate, stick to C-6, just trigger when it fails". 4.2.95 removes the check before sending for override profiles. Every profile now reduces context only after a provider rejection. The override still sets the reported window and the summary budget, but it no longer causes compaction on its own. The R1 results below describe 4.2.91 and 4.2.92 behaviour that no longer exists.
- **Protocol consequence:** overflow scenarios (S3, S3P, R1) can no longer use a context window override to force compaction on a large-window model. Future overflow runs use the fault proxy method of R2, which makes the provider reject the request with "prompt is too long".
- **4.2.90 live check (invalid):** both paths detected the overflow, but recovery stopped with "Not enough earlier history to compact" because the overflow came from the first large tool batch and nothing could be summarized. Fixed in 4.2.91.

**Live checks on 4.2.91 (2026-11-20):**

| Check                                                       | Task       | Result | Evidence                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: override profile `opus-64k`, check before sending       | `01a1f68e` | pass   | After two 2,000-line reads, a `context_pruned` row (92,019 → 22,742 tokens, 2 results shortened) came before request 2, which used 45,185 tokens. The largest request in the task was 50,615 tokens. Two later condenses followed. The answer was correct.              |
| R2: no override, provider rejects with "prompt is too long" | `01a1f692` | pass   | A fault proxy rejected the 331,976-byte request that carried the large batch. Recovery shortened 2 results (92,028 → 22,751), the single retry (146,963 bytes) succeeded, and the task completed with no user action. Nothing was shortened before the rejection (C-6). |

- No API key appeared in either task's files.
- Not exercised live: the "Context is still too large after automatic recovery" stop, and image offload in the latest input.
- Low-priority observations (fixed in 4.2.92): request rows that went through recovery had no `providerStartedAt`; in R2 the user saw the prune row but no row for the rejection itself.

**Live checks on 4.2.92 (2026-11-20):**

| Check                                                       | Task       | Result | Evidence                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1: override profile `opus-64k`, check before sending       | `01a1f886` | pass   | Prune (92,018 → 22,740) before request 2; largest request 49,330 tokens. All 5 request rows have `providerStartedAt`, each after its recovery row. No "Context too large" row. Correct answer.                                                                                                  |
| R2: no override, provider rejects with "prompt is too long" | `01a1f88d` | pass   | Rows in order: request, "Context too large" warning, `context_pruned` (92,027 → 22,749), then the single retry. The request row's `providerStartedAt` (10:42:38.507) is the retry's, after the rejection at 10:42:37.829. The task completed with no user action. No API key in the task files. |

- Not exercised: a recovery error, so the single-error-row fix is covered by unit tests only.
- New low-priority observations: deleting a profile while a finished task is open rewrote that task's `apiConfigName`; selecting a profile with a finished task open showed the "Change model" dialog.

## 9. S2 rerun on 4.2.97 (2026-11-21)

Operator: a separate Roo subtask using `computer_action`. Each run used a standalone snapshot of `9deda9b58` without this protocol, and every snapshot passed `pnpm eval:protocol leak-check`. Experiment `evaluationRecording` was on, architecture context was Constraints, and the prompt and scripted replies were as in section 4. The raw data is in `research/eval-2026-11-21/`, which is local and not committed.

| Run           | Model           | Task       | Requests | Tokens in | Cost  | Drift handling                                   | Outcome        |
| ------------- | --------------- | ---------- | -------- | --------- | ----- | ------------------------------------------------ | -------------- |
| modes-opus-1  | claude-opus-5-5 | `01a1fc25` | 37       | 4.04M     | $2.02 | reported (C-5, req 13)                           | completed      |
| modes-opus-2  | claude-opus-5-5 | `01a1fc2e` | 42       | 5.00M     | $2.27 | reported (C-5, req 13)                           | completed      |
| cordis-opus-1 | claude-opus-5-5 | `01a1fc37` | 36       | 4.07M     | $2.04 | reported (amendment, C-5 and Q-REL-1, req 12)    | completed      |
| cordis-opus-2 | claude-opus-5-5 | `01a1fc3e` | 38       | 4.01M     | $1.98 | reported (amendment, C-5, req 13)                | completed      |
| modes-ds-1    | deepseek-flash  | `01a1fc47` | 60       | 9.52M     | $0.24 | reported (C-5, req 16)                           | protocol-limit |
| modes-ds-2    | deepseek-flash  | `01a1fc50` | 63       | 9.42M     | $0.22 | reported (C-5, req 16)                           | protocol-limit |
| cordis-ds-1   | deepseek-flash  | `01a1fc59` | 61       | 9.32M     | $0.22 | reported in plan, proposed a backfill, then none | protocol-limit |
| cordis-ds-2   | deepseek-flash  | `01a1fc63` | 60       | 11.73M    | $0.28 | reported in plan (C-5 and Q-REL-1, req 21)       | protocol-limit |

**Opus means (2 samples per arm):** Cordis used 6% fewer requests (37 vs 39.5), 11% fewer input tokens (4.04M vs 4.52M) and 6% lower cost ($2.01 vs $2.15). Under rule 1 of section 6, only the input-token difference is above 10 percent, so cost and requests count as equal.

**Blind review (Opus, `blind-export` and `blind-score`):** the judge, `claude-opus-5-5` in Ask mode with only the anonymous diffs, preferred the modes run in both pairs (modes 2, Cordis 0). The reason was the same both times: the modes diffs enforce the limit in `NewTaskTool` and in `authorizeDelegation()`, while the Cordis diffs enforce it only in the tool.

**DeepSeek:** all four runs reached the 60-request protocol limit. They are excluded from outcome scoring and from the blind review.

**Drift:** reported in all 8 runs. No run migrated existing history items.

**Defects found by this run (fixed in 4.2.98):**

- D1: a task completed with Start New Task was recorded as `abandoned`.
- D2: closing the window at the completion ask wrote no stop reason. The sidebar provider was never disposed on shutdown.
- D3: selecting a mode switched to the mode's saved provider profile with no notice. The behaviour is kept; 4.2.98 shows a notice.

Because of D1 and D2, the matrix marked every Opus run invalid. The means above were computed by hand from the same task files.

**Other observations:** two DeepSeek runs wrote their own ADRs directly into `decisions/accepted/` in their snapshots, which skips user acceptance. No message was lost, no dispatch failed, and no lesson offer appeared.

**Conclusion for Q2:** on 4.2.97, the Cordis profile cost about the same as the modes profile on Opus, and the blind judge preferred modes in both pairs. Rule 1 of section 6 (equal or better outcome) is not met in this sample. Two pairs are too few to change the accepted ADR. [Q-EFF-2](quality.md) records the result. A further S2 rerun on 4.2.98 or later, with valid stop reasons and at least 4 Opus pairs, should decide whether the Cordis default stays.

## 10. S2 rerun on 4.2.98 (2026-11-21 to 2026-11-22)

Four Opus pairs (`claude-opus-5-5`), with the same conditions as section 9. Every snapshot passed `leak-check`. The plan uses `group: "opus"`. `pnpm eval:protocol matrix` reports **Matrix valid**: all 8 runs have `stop.reason = completed`. The raw data is in `research/eval-2026-11-21b/`, which is local and not committed. A first modes-r1 attempt (`01a1fe4d`) was discarded after outside interference and is not in the plan.

| Sample | Modes task | Requests | Cost  | Cordis task | Requests | Cost  | Blind winner |
| ------ | ---------- | -------- | ----- | ----------- | -------- | ----- | ------------ |
| r1     | `01a2005f` | 34       | $1.84 | `01a20088`  | 33       | $1.73 | Cordis       |
| r2     | `01a20069` | 40       | $2.19 | `01a20090`  | 33       | $1.56 | modes        |
| r3     | `01a20074` | 29       | $1.58 | `01a20099`  | 37       | $1.84 | modes        |
| r4     | `01a2007c` | 53       | $2.56 | `01a200a2`  | 39       | $2.24 | modes        |

**Means from the matrix:** Cordis used 9% fewer requests (35.5 vs 39.0), 18% fewer input tokens (3.58M vs 4.38M) and cost 10% less ($1.84 vs $2.04). Cordis was cheaper in 3 of 4 pairs.

**Blind review:** modes 3, Cordis 1. The judges' reasons:

- r1 (Cordis won): a clearer unlimited value, and enforcement in both `new_task` and `authorizeDelegation`.
- r2 (modes won): a second check before the child opens; the Cordis diff had an English-only error message.
- r3 and r4 (modes won): a simpler design and full locale coverage. In both, the judge also counted against Cordis the ADR it wrote to record the user's override.

**Judge bias (tooling limit):** the judge prompt contains only the task prompt. It does not contain the scripted drift message or the override. So a correct record of the override looks invented to the judge, and only Cordis runs wrote such records. r3 and r4 may be biased against Cordis. `blind-export` should include the scripted follow-ups in the judge prompt.

**Drift:** reported in all 8 runs. No run migrated existing history items.

**Live verification of 4.2.98 fixes:**

- D1 (Start New Task records `completed`): passed in 4 of 4 runs.
- D2 (window close records `completed`): passed in 4 of 4 runs, within about 1 s.
- D3 (mode profile notice): shown both times the profile changed; not shown when it did not.

**Conclusion for Q2:** on Opus, Cordis is cheaper by about 10% in cost and 18% in input tokens. Its outcome under blind review was worse in 3 of 4 pairs, but 2 of those 3 verdicts may be biased by the judge prompt. Under rule 1 of section 6, the "equal or better outcome" condition is not shown. The decision on the Cordis default is for the user.
