# ADR-2026-11-13-task-state-ledger: Task-local state ledger with bounded recall

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/services/task-state/\*\*, src/core/task/Task.ts

## Problem

Long tasks lose their goal, decisions, and failed approaches after compaction or resume.

## Decision

Keep an opt-in, revisioned, task-local ledger (goal, next action, acceptance criteria, constraints, decisions, work items, evidence, failed approaches, blockers). Recall a bounded rendering into the conversation at safe turn boundaries and after compaction. All edits are model claims, not proof. Writes use the ledger revision to detect conflicts ([`../../../task-state.md`](../../../task-state.md)).

## Alternatives considered

- Rely on summaries only: decisions are lost ([R-3](../../risks.md)).
- Project memory: wrong scope; it is shared across tasks.

## Consequences

### Acceptance criteria

- Recall is bounded (24,000 characters) and re-appended after compaction.
- Concurrent writes fail with a conflict instead of overwriting.

### Risks

- Recalled content is sent to the provider; users must not store secrets ([Q-SEC-2](../../quality.md)).
