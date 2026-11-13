# ADR-2026-11-13-overflow-only-context-recovery: Reduce context only after provider overflow
Status: proposed
Source: reconstructed
Last-verified: 2026-11-13
Paths: src/core/context-management/**, src/core/condense/**, src/core/task/Task.ts

## Problem
Proactive compaction at a percentage threshold summarized history that still fit, lost detail, and broke prompt-cache reuse.

## Proposal
Send requests without proactive compaction. Only when the provider rejects a request for context size: reduce context once (summary, with optional truncation fallback), save an exact pre-event snapshot, and retry once. Stop on a second failure ([`../../../context-budget.md`](../../../context-budget.md), [`../../../context-recovery.md`](../../../context-recovery.md)). Planned extension: prune old tool results and offload images before summarizing.

## Alternatives considered
- Threshold-based proactive compaction: out of scope by decision.
- Truncation only: drops content without a summary.

## Acceptance criteria
- No reduction happens without a provider overflow.
- At most one recovery and one retry per request.
- Each recovery event has a snapshot for Recover in new branch.

## Risks
- Recovery breaks prompt-cache reuse from the first changed message: [R-4](../../risks.md).
- Related constraint: [C-6](../../constraints.md); quality goal [Q-REL-2](../../quality.md).
