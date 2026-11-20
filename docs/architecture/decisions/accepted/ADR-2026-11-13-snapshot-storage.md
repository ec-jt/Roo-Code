# ADR-2026-11-13-snapshot-storage: Deduplicated content-addressed request snapshots

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/task/model-operation/\*\*

## Problem

Each request snapshot stored the complete message history, so storage grew quadratically with task length.

## Decision

Store new snapshots as version-2 manifests that reference task-local content-addressed blocks. Keep the public snapshot API and the version-1 reader. Do not migrate existing data. Each task owns its block directory; branches copy blocks instead of linking them ([`../../../snapshot-storage.md`](../../../snapshot-storage.md)).

## Alternatives considered

- Keep full snapshots: unbounded growth.
- Global shared block store: cross-task ownership and deletion problems.
- Migrate legacy snapshots: violates [C-5](../../constraints.md).

## Consequences

### Acceptance criteria

- New snapshots round-trip through the public API unchanged.
- Legacy version-1 snapshots remain readable.

### Risks

- Older builds cannot read version-2 snapshots: [R-2](../../risks.md).
