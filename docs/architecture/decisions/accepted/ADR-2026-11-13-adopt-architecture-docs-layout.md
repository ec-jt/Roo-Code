# ADR-2026-11-13-adopt-architecture-docs-layout: Adopt the arc42 architecture docs layout
Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: docs/architecture/**

## Problem
Architecture knowledge is spread across feature docs, release notes, and plans. Agents re-open settled decisions and cannot cite stable IDs, especially after context compaction.

## Decision
Keep architecture records in `docs/architecture/`, indexed by [`arc42.md`](../../arc42.md), in the format of [`RECORD-FORMAT.md`](../../RECORD-FORMAT.md). Use stable IDs (`C-`, `Q-`, `R-`, `ADR-`). Decision records live in one folder per status. Architect mode owns the folder; other modes report drift. A check script validates the layout.

## Alternatives considered
- A single architecture document: hard to cite and to select by path.
- Records in task state or project memory only: not versioned with the code and not reviewable in pull requests.
- Importing the Cordis library record system: rejected; the library is not imported.

## Consequences
- Agents can cite IDs in plans, ledgers, handoffs, and summaries.
- The architecture context provider can select records by `Paths`.
- Backfilled records stay `proposed` with `Source:` until the user confirms them.
