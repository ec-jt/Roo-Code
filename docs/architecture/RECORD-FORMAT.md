# Architecture record format

This file defines the format of all records under `docs/architecture/`. The check script (`pnpm check:architecture`, phase 2) enforces it.

## Identifiers

| Kind | ID pattern | Location |
|---|---|---|
| Constraint | `C-<n>` | [`constraints.md`](constraints.md) |
| Quality goal | `Q-<AREA>-<n>` (AREA in upper case, for example `Q-REL-1`) | [`quality.md`](quality.md) |
| Risk | `R-<n>` | [`risks.md`](risks.md) |
| Decision | `ADR-YYYY-MM-DD-<topic>` (topic in lower case, digits, hyphens) | `decisions/<status>/ADR-YYYY-MM-DD-<topic>.md` |

IDs are unique across all files. Every cited ID must resolve to a record.

## Decision records

One file per decision. The folder must match the `Status` line.

```
# ADR-YYYY-MM-DD-topic: Title
Status: proposed | accepted | rejected | superseded
Accepted-by: user | agent (task <taskId>)        # required when accepted
Superseded-by: ADR-...                           # required when superseded
Source: inferred | reconstructed                 # optional; flagged until removed
Last-verified: YYYY-MM-DD
Paths: src/core/condense/**, src/core/context-management/**   # optional; used for context selection

## Problem
## Decision            (or ## Proposal while proposed)
## Alternatives considered
## Consequences        (or ## Acceptance criteria and ## Risks while proposed)
```

Required sections by status:

| Status | Required sections |
|---|---|
| proposed | Problem, Proposal, Alternatives considered, Acceptance criteria, Risks |
| accepted, rejected, superseded | Problem, Decision, Alternatives considered, Consequences |

## Constraints, quality goals, and risks

Each entry is a level-3 heading followed by the same header lines as a decision record:

```
### Q-REL-1: Title
Status: proposed | accepted
Accepted-by: user | agent (task <taskId>)        # required when accepted
Source: inferred | reconstructed                 # optional
Last-verified: YYYY-MM-DD
Paths: src/core/**                               # optional

Text. Quality goals add a "Scenario:" paragraph (stimulus, environment, response, measure).
```

## Header line rules

- `Source:` marks content that a person has not confirmed. The check script reports it as a warning until the line is removed.
- `Last-verified` older than 180 days is reported as a warning.
- `Paths` is a comma-separated list of repository-relative globs.

## Who may accept

The setting `architectureDecisionApproval` controls acceptance:

- `user` (default): only the user accepts decisions and quality goals. `Accepted-by: agent` is an error.
- `agent`: an agent may accept decisions and quality goals and writes `Accepted-by: agent (task <taskId>)`. With the auto-approval master switch off, `agent` behaves as `user`.

Reversals always need the user: reject or supersede an accepted record, or weaken or remove an accepted quality goal.

The check script enforces this, not the runtime:

```
pnpm check:architecture                        # same as --approval user
pnpm check:architecture -- --approval agent
pnpm check:architecture -- --root docs/architecture
```

## Lifecycle

1. Create a decision in `decisions/proposed/` with `Status: proposed`.
2. On acceptance, move the file to `decisions/accepted/`, set `Status: accepted`, add `Accepted-by`, and rename the `Proposal` section to `Decision`.
3. On rejection, move it to `decisions/rejected/` and set `Status: rejected`.
4. To replace an accepted decision, accept the new record, then move the old one to `decisions/superseded/` with `Status: superseded` and `Superseded-by: <new ID>`.
