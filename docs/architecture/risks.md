# 11. Risks and technical debt

Format: [`RECORD-FORMAT.md`](RECORD-FORMAT.md).

### R-1: Task.ts is very large

Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts

`Task.ts` holds the request loop, context injection, recovery, and dispatch in one file of several thousand lines. Line numbers in plans go stale quickly and changes conflict easily. Mitigation: extract cohesive helpers (as done for `subtask-handoff.ts`) when a phase touches a region.

### R-2: Version-2 snapshots are not readable by older builds

Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task/model-operation/\*\*

Rolling back to a build that reads only version-1 envelopes cannot replay newer snapshots ([`../snapshot-storage.md`](../snapshot-storage.md)). Related: [Q-REL-1](quality.md).

### R-3: Summaries lose decisions and failed approaches

Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/condense/\*\*, src/shared/support-prompt.ts

After compaction the agent can re-open settled decisions or retry abandoned approaches. Mitigation: the ledger recall and the planned compaction sections (failed approaches, architecture IDs, blockers).

Evidence from the [2026-11-18 evaluation](evaluation-2026-11-18.md), S3 rerun on 4.2.80:

- **Recovery:** 6 summaries across 3 runs, with 0 re-opened decisions. One run repeated a failed approach, but that run had pruning off.
- **Earlier defect, fixed:** in 4.2.23 to 4.2.79, recovery ended the task when the reply after the summary contained only a tool call.
- **Pruning verified (S3P scenario):** pruning ran before a summary in a live task. The model did not re-read the pruned files with `read_file`, and there was no recovery failure.

### R-4: Prompt-cache invalidation from context changes

Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts, src/core/context-management/\*\*

Rewriting earlier messages (pruning, offload, summary) breaks cache reuse from the first changed message. Accepted only during overflow recovery. Related: [Q-EFF-1](quality.md).

### R-5: Cordis preview admission is Anthropic-only

Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/api/preview-runtime.ts, src/api/dispatch-admission.ts

The `cordisRuntimePreview` dispatch path covers only Anthropic. Other providers use the normal path, so behaviour can differ by provider.

Note (2026-11-19): the accepted [ADR-2026-11-19-keep-cordis-profile-widen-experiment](decisions/accepted/ADR-2026-11-19-keep-cordis-profile-widen-experiment.md) turns the Cordis profile on by default for all providers. This risk then covers only the dispatch runtime: on other providers a Cordis task has no dispatch admission, and a reply without a tool call takes the normal reminder path. All evaluation samples used Anthropic.
