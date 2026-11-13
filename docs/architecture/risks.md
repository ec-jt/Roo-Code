# Risks and technical debt

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
Paths: src/core/task/model-operation/**

Rolling back to a build that reads only version-1 envelopes cannot replay newer snapshots ([`../snapshot-storage.md`](../snapshot-storage.md)). Related: [Q-REL-1](quality.md).

### R-3: Summaries lose decisions and failed approaches
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/condense/**, src/shared/support-prompt.ts

After compaction the agent can re-open settled decisions or retry abandoned approaches. Mitigation: the ledger recall and the planned compaction sections (failed approaches, architecture IDs, blockers).

### R-4: Prompt-cache invalidation from context changes
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts, src/core/context-management/**

Rewriting earlier messages (pruning, offload, summary) breaks cache reuse from the first changed message. Accepted only during overflow recovery. Related: [Q-EFF-1](quality.md).

### R-5: Cordis preview admission is Anthropic-only
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/api/preview-runtime.ts, src/api/dispatch-admission.ts

The `cordisRuntimePreview` dispatch path covers only Anthropic. Other providers use the normal path, so behaviour can differ by provider.
