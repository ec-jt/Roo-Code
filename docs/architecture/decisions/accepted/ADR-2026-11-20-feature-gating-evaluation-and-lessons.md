# ADR-2026-11-20-feature-gating-evaluation-and-lessons: Gate evaluation recording, lessons and harness tooling

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: packages/types/src/experiment.ts, src/services/memory/**, src/core/tools/NewTaskTool.ts, src/core/webview/worktree/**, packages/evals/**, scripts/**

## Problem

The 2026-11-18 evaluation set the Cordis default and the overflow-recovery defaults. Its method had gaps that [R-6](../../risks.md) lists:

- one sample per run for S1 and S3;
- S2 samples on five different builds (4.2.78 to 4.2.84);
- outcomes scored by an operator who knew which arm was which;
- a protocol leak through `git diff` in S1 attempt 2 (evaluation run log);
- invalid runs recorded only in prose;
- DeepSeek runs stopped by the 60-request protocol limit but scored "acceptable" (S2 sample 5).

Harness² (`google-research/harness2`, commit `6868817`, read on 2026-11-20) addresses the same problems in its own runner:

- **Run fingerprints** (`core/runmark.py`): a digest of the harness and of the task inputs. A run is reused only if both match.
- **Leak checks** (`core/context.py`, `assert_no_leak_paths` and `assert_no_grader_verdicts`): answer-key paths and grader verdicts are refused before they reach the model.
- **Budget identity check** (`core/ledger.py`, `assert_identity`): the run fails unless the expected runs are present, with no duplicate labels.
- **Exit annotation** (PR #122): a run that ends with a non-zero exit gets an error event in its trajectory.
- **Blind selection** (`core/selection.py`): anonymous candidate IDs, a separate judge session, and a written reason.
- **Lessons gated by evidence** (`core/library.py`, `has_experience`): a lesson is stored only with a cue, a lesson and evidence, and the reflector may answer `NO_ENTRY`.

Roo also has no isolated workspace for subtasks ([R-7](../../risks.md)). `new_task` takes no working directory, so independent attempts cannot run side by side.

[R-3](../../risks.md) (summaries lose decisions and failed approaches) applies inside one task. Nothing carries a lesson that has evidence across tasks.

The user asked (2026-11-20) for:

- evaluation features that can be turned on and off;
- lessons that work like memories, with their own toggle;
- the harness improvement loop and the environment check in development mode only.

## Decision

| Feature                                                     | Audience         | Gate                                                                                                                                                                        | Default     |
| ----------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Evaluation recording                                        | All users        | New experiment `evaluationRecording` in Settings > Experimental                                                                                                             | off         |
| Lessons                                                     | All users        | **Save lessons** sub-toggle in Settings > Memory. Stored in a separate per-project control file, `<projectKey>.lessons-consent.yaml`. Works only when project memory is on. | off         |
| Evaluation tooling (leak check, matrix check, blind review) | Developers       | Repository scripts or `packages/evals`. Not shipped in the VSIX.                                                                                                            | not shipped |
| Harness improvement loop                                    | Developers       | Repository scripts, or a command registered only when `extensionMode === ExtensionMode.Development`                                                                         | not shipped |
| Environment inheritance check                               | Developers       | Investigation only. A scrub fix found by it ships to all users ([Q-SEC-2](../../quality.md)).                                                                               | not shipped |
| Isolated subtask workspace                                  | Developers first | `new_task` option available only in `ExtensionMode.Development`, until R-7 and the merge experience are evaluated                                                           | off         |

### Evaluation recording (experiment)

When the experiment is on, a new task writes `evaluation.json` in its own task folder. The file holds:

- **Run manifest:** extension version and commit; a digest of the settings that affect behaviour; provider and model ID; mode or profile; a hash of the first prompt.
- **Stop reason,** written once when the task ends: `completed`, `user-stopped`, `error`, `mistake-limit` or `abandoned`.

No prompt text, keys or URLs are stored, only hashes. Old tasks are never read in bulk or rewritten ([C-5](../../constraints.md)). When the experiment is off, nothing is written.

### Lessons (memory sub-toggle)

- **Record:** a lesson is a project memory topic with `type: lesson`. Lessons are allowed in the project scope only. The body has the lines `cue:`, `lesson:` and `evidence:`, and optionally `confidence:` (`low`, `medium`, `high`, or a number from 0 to 1). The evidence must contain a task ID (a UUID), with a request or tool-call reference.
- **Validation:** the store rejects a lesson without cue, lesson or evidence, or with duplicate keys, with error code `INVALID_LESSON`. The model may answer `NO_ENTRY`, which needs no tool call.
- **Writing:** the model writes lessons only in its own turn, under the existing memory consent and approval rules. There is no extra model call and no background job.
- **From task state:** a task-state `failedApproaches` entry can be offered as a lesson at `attempt_completion`, after approval.
- **Recall:** lessons are recalled inside the existing 16 KiB index, as lower-trust data ([Q-SEC-1](../../quality.md)).
- **Toggle storage (amended 2026-11-20, approved by the user):** the toggle is stored in a separate control file, `memory/controls/<projectKey>.lessons-consent.yaml`, with the keys `saveLessons` and `revision`. It uses the same lock, atomic write and revision pattern as the consent document. The consent document is never changed: older builds accept it only with exactly the keys `enabled`, `personalRecall` and `revision`, so adding a key would turn memory off after a rollback. A missing or invalid control file reads as off.
- **Where the gate is enforced:** `MemoryStore.requireLessonWrite`, checked in `upsert()` before the lock, under the scope lock, and under the consent lock after authorization. Also `MemoryTool.assertLessonGate`, on every recheck. Reading, recall, forgetting and clearing are not gated.

### Development-only rule

A tool marked development only must not register a command, setting or tool in a production extension host. It runs only from repository scripts or when the host is in `ExtensionMode.Development`.

## Alternatives considered

- **Always-on evaluation recording.** Rejected: it writes an extra file for every task, for users who never run evaluations.
- **Lessons always on with project memory.** Rejected by the user: lessons are a separate kind of write and need their own consent.
- **Harness recursion inside the product (Propose, Probe, Compose for each user task).** Rejected: it multiplies cost by about 4k per task ([Q-EFF-1](../../quality.md)) and needs isolated parallel rollouts that Roo does not have ([R-7](../../risks.md)).
- **Use ordinary subtasks as probes.** Rejected: subtasks share the parent workspace and run one at a time, so probes would see each other's edits.

## Consequences

### Acceptance criteria

- With `evaluationRecording` off, no `evaluation.json` is written, and a test proves it.
- With it on, a new task writes one manifest and exactly one stop reason. The file contains no prompt text or secrets.
- **Save lessons** is disabled while project memory is off. An old consent file reads as off. A lesson without evidence is rejected with a stable error code.
- No development-only command or tool is registered when the extension host is in production mode, and a test proves it.
- All new user-visible strings have keys in all 18 locales ([C-7](../../constraints.md)).

### Risks

- **Selection effect:** evaluation recording measures only users who turn it on, so it is not product telemetry.
- **Lesson quality:** wrong lessons can bias later tasks. Mitigation: the evidence requirement, lower-trust labelling, and the existing forget and clear controls.
- **Rollback with saved lessons:** a build before 4.2.95 reports each lesson topic as an invalid record. It does not delete it and does not recall it. In that project, that older build also refuses to save topics, refuses Forget all, and cannot forget a lesson. Recovery: delete the lesson files by hand, or return to 4.2.95 or later and forget them there. Related: [R-2](../../risks.md).
- **Follow-up, not built:** offer task-state `failedApproaches` entries as lessons at `attempt_completion`, after approval.
- **Isolated subtasks:** these need checkpoint storage keyed by worktree path and a merge step. They are not designed yet beyond this gate.
- **Harness² transfer:** the reported gains (up to 11.8 points) come from professional benchmarks, not coding-agent tasks. They are not evidence that Roo will improve.
