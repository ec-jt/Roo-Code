# ADR-2026-11-20-offline-harness-improvement-loop: Development-only harness improvement from execution evidence

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/prompts/**, src/core/prompts/tools/**, scripts/eval-protocol.ts, docs/eval-protocol-tooling.md

## Problem

Fixes to prompts and tool guidance have come from a person reading run logs. Evidence from the 2026-11-18 evaluation run log:

- 4.2.81: a missing tool reminder in the Cordis profile.
- 4.2.85 to 4.2.88: `task_state` argument handling, after DeepSeek runs failed schema validation repeatedly.

Each of these needed several builds before the fix held. Changes are not compared against the previous harness on the same task, so it is unclear which edit helped.

Harness² (`google-research/harness2`, commit `6868817`) improves a harness without ground truth:

- **Propose:** an editor proposes changes on two dimensions. INV covers how the agent works. DOM covers domain knowledge (`core/prompts.py`).
- **Probe:** each candidate runs on the same task (`core/recursion.py`, `run_parallel` and `run_sequential`).
- **Compose:** a composer combines the edits. Every edit must cite the trajectory moment it came from (`core/context.py`, `mission`).
- **Fallback:** an invalid proposal gets one retry, then the current harness is kept (`_run_stage`).
- **Cost:** about 4k rollouts per task.

## Decision

A development-only loop, run from repository scripts. Nothing is registered in a production extension host.

1. **Editable surface:**
    - **INV:** `src/core/prompts/sections/cordis.ts`, the Cordis profile, native tool descriptions in `src/core/prompts/tools/native-tools/`, and mode role definitions.
    - **DOM:** `.roo/rules/`, `.roo/skills/`, `AGENTS.md`, and architecture context.
2. **Probe:** apply each candidate edit to a separate build or workspace, and run the S1 to S3 scenarios with `evaluationRecording` on.
    - Each probe runs in its own snapshot: by hand at first, or through [ADR-2026-11-20-isolated-subtask-workspace](ADR-2026-11-20-isolated-subtask-workspace.md) once it is accepted.
3. **Check:** use `pnpm eval:protocol` (`docs/eval-protocol-tooling.md`):
    - `leak-check` before each run;
    - `matrix` to confirm that the runs are complete and comparable;
    - `blind-export` and `blind-score` to compare outcomes.
4. **Compose:** one edit, made by a person or a separate Roo task. Every change must cite a task ID and request number where the behaviour changed ([`RECORD-FORMAT.md`](../../RECORD-FORMAT.md), evidence rule). An edit without such a citation is dropped.
5. **Ship:** the composed edit ships through the normal release. It records its evidence in the release notes.

## Alternatives considered

- **Run the loop for every user task.** Rejected: it multiplies cost by about 4k ([Q-EFF-1](../../quality.md)), and Roo subtasks cannot run isolated probes ([R-7](../../risks.md)).
- **Keep fixing by hand from logs.** This is the status quo. It works, but each edit is not compared against the previous harness on the same task.
- **Use the Harness² code directly.** Rejected: it targets OpenCode and Codex runners and benchmark adapters, not a VS Code extension.

## Consequences

### Acceptance criteria

- No new command, setting or tool is shipped in the VSIX.
- One loop cycle on S2 produces a composed edit with cited evidence, and a `matrix` report with no invalid cells.
- The blind comparison of the composed edit against the base is recorded in a new evaluation file.

### Risks

- **Cost:** model spend per cycle is several times one S2 pair. Limit each cycle to one scenario.
- **Overfitting:** an edit that helps S1 to S3 may not help other tasks. Rotate scenarios and keep the evidence rule.
- **Transfer:** Harness² gains (up to 11.8 points) were measured on professional benchmarks, not coding-agent tasks. They are not evidence that this loop will improve Roo.
