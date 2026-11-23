# 11. Risks and technical debt

Format: [`RECORD-FORMAT.md`](RECORD-FORMAT.md).

### R-1: Task.ts is very large

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts

`Task.ts` holds the request loop, context injection, recovery, and dispatch in one file of several thousand lines. Line numbers in plans go stale quickly and changes conflict easily. Mitigation: extract cohesive helpers (as done for `subtask-handoff.ts`) when a phase touches a region.

### R-2: Version-2 snapshots are not readable by older builds

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task/model-operation/\*\*

Rolling back to a build that reads only version-1 envelopes cannot replay newer snapshots ([`../snapshot-storage.md`](../snapshot-storage.md)). Related: [Q-REL-1](quality.md).

Note (2026-11-20): rollback also affects memory lessons. A build before 4.2.95 treats a `lesson` topic as an invalid record. In that project it then blocks saving topics and Forget all, and cannot forget a lesson. Recovery: delete the lesson files by hand, or forget them in 4.2.95 or later. See [ADR-2026-11-20-feature-gating-evaluation-and-lessons](decisions/accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md).

### R-3: Summaries lose decisions and failed approaches

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/condense/\*\*, src/shared/support-prompt.ts

After compaction the agent can re-open settled decisions or retry abandoned approaches. Mitigation: the ledger recall and the planned compaction sections (failed approaches, architecture IDs, blockers).

Evidence from the [2026-11-18 evaluation](evaluation-2026-11-18.md), S3 rerun on 4.2.80:

- **Recovery:** 6 summaries across 3 runs, with 0 re-opened decisions. One run repeated a failed approach, but that run had pruning off.
- **Earlier defect, fixed:** in 4.2.23 to 4.2.79, recovery ended the task when the reply after the summary contained only a tool call.
- **Pruning verified (S3P scenario):** pruning ran before a summary in a live task. The model did not re-read the pruned files with `read_file`, and there was no recovery failure.
- **Offload verified (4.2.85, live check C3):** images were offloaded before a summary. Afterwards the model stated it could not see the offloaded image instead of inventing its content.

### R-4: Prompt-cache invalidation from context changes

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts, src/core/context-management/\*\*

Rewriting earlier messages (pruning, offload, summary) breaks cache reuse from the first changed message. Accepted only during overflow recovery. Related: [Q-EFF-1](quality.md).

### R-5: Cordis preview admission is Anthropic-only

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/api/preview-runtime.ts, src/api/dispatch-admission.ts

The `cordisRuntimePreview` dispatch path covers only Anthropic. Other providers use the normal path, so behaviour can differ by provider.

Note (2026-11-19): the accepted [ADR-2026-11-19-keep-cordis-profile-widen-experiment](decisions/superseded/ADR-2026-11-19-keep-cordis-profile-widen-experiment.md) turns the Cordis profile on by default for all providers. This risk then covers only the dispatch runtime: on other providers a Cordis task has no dispatch admission, and a reply without a tool call takes the normal reminder path. All evaluation samples used Anthropic.

Note (2026-11-22): the runtime (`selectPreviewRuntime()` in `src/api/preview-runtime.ts`) is currently an admission hook that grants every request. It is the planned place for concurrency limits and a shared budget for parallel subtasks. [ADR-2026-11-22-parallel-subtasks](decisions/accepted/ADR-2026-11-22-parallel-subtasks.md) proposes using it on every provider for parallel children.

### R-6: Evaluation results can be invalid or biased

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: docs/architecture/evaluation-\*.md

The 2026-11-18 evaluation set defaults and an accepted ADR from small samples. Known weaknesses:

- one sample per run for S1 and S3;
- S2 samples on five different builds;
- outcomes scored by an operator who knew which arm was which;
- protocol leaks found only by hand (S1 attempt 2 saw the protocol through `git diff`);
- invalid runs recorded only in prose;
- runs stopped by the protocol's request limit scored like finished runs.

Mitigation: the evaluation tooling in [ADR-2026-11-20-feature-gating-evaluation-and-lessons](decisions/accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md). It adds a run manifest and pools only runs with matching manifests. It also adds a leak check before each run, a matrix check, stop reasons, and blind pairwise review. These ideas come from Harness² (`google-research/harness2`, commit `6868817`: `core/runmark.py`, `core/context.py`, `core/ledger.py`, `core/selection.py`). Related: [Q-EFF-2](quality.md).

### R-7: Subtasks can only share the parent's workspace

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/tools/NewTaskTool.ts, src/core/webview/worktree/\*\*

`new_task` takes no working directory. A child task always runs in the parent's workspace folder, on the same files and the same checkpoint history, while the parent waits. Sharing is the right choice for many subtasks, for example when the parent builds on the child's changes. The risk is that there is no other choice when the requirements need isolation:

- a child always sees and can change the parent's uncommitted work;
- two independent attempts at the same change cannot run side by side or be compared;
- evaluation runs need a separate snapshot made by hand.

Worktree support exists in `src/core/webview/worktree/`, but only as user actions. Mitigation: let the parent choose `shared` or `isolated` for each subtask from the requirements (user, 2026-11-20). See [ADR-2026-11-20-isolated-subtask-workspace](decisions/accepted/ADR-2026-11-20-isolated-subtask-workspace.md).

### R-8: Parallel subtasks multiply cost

Status: accepted
Accepted-by: user
Last-verified: 2026-11-22
Paths: src/core/task/parallel/\*\*, src/api/dispatch-admission.ts

Several children running at the same time can spend several times the cost of one task in the same wall-clock time, and the sum of their requests can hit provider rate limits. Mitigation: a shared token budget per batch and a concurrency limit, both enforced by the dispatch runtime, and the experiment `parallelSubtasks` off by default. See [ADR-2026-11-22-parallel-subtasks](decisions/accepted/ADR-2026-11-22-parallel-subtasks.md).

### R-9: Parallel child branches can conflict

Status: accepted
Accepted-by: user
Last-verified: 2026-11-22
Paths: src/core/task/parallel/\*\*, src/core/tools/subtask-workspace.ts

Each parallel child works on its own `roo/subtask/<id>` branch from the same base. Two children can change the same files, so merging both branches can conflict. Mitigation: the parent receives each child's diff stat. Merging is done by the parent or the user, and conflicts are reported, never resolved automatically.
