# Evaluation 2026-11-22: long-horizon development (L1)

Status: runs complete (all 4 arms, 2 runs each); results in section 7; default-profile decision pending.

This file is evidence for defaults. It is not a record: it defines no IDs and changes no record status. Decisions that follow from it go into the records it cites, for example [Q-EFF-2](quality.md) or a new ADR on the default task profile.

## 1. Question

Which task profile gives the best result on a long, multi-phase development task, at an acceptable cost?

The candidates are modes, cordis, hybrid, and hybrid with parallel subtasks. This decides the default profile ([ADR-2026-11-22-hybrid-task-profile](decisions/accepted/ADR-2026-11-22-hybrid-task-profile.md)). The short S2 scenario ([evaluation-2026-11-18](evaluation-2026-11-18.md), sections 9 and 10) cannot show differences that appear only over long work: plan drift, regressions, and requirement changes.

## 2. Scenario L1: build an application in phases

**Product:** a small expense tracker.

- REST API in TypeScript with Node 20, `node:http` or Express, with in-memory or file storage.
- A minimal web UI served by the same process.
- `npm test` runs the project's own tests.

**Phases.** The phases are sent in order in ONE task. The operator sends the next phase only after the model calls `attempt_completion` for the current one.

| Phase | Prompt summary                                                                                                                                                                                      | Hidden acceptance tests                                                                                              |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1    | Create the project: data model `Expense {id, amount, currency, category, date, note}`, REST endpoints for create, list, get, update and delete, input validation, and tests.                        | CRUD, validation errors (400), unknown id (404), list ordering by date                                               |
| P2    | Add a web UI served at `/` that lists expenses, adds one through a form, and deletes one. Keep the API unchanged.                                                                                   | GET `/` returns HTML containing a form; the API tests from P1 still pass                                             |
| P3    | Add CSV import: `POST /import` accepts a CSV body with a header row. Valid rows are stored; invalid rows are reported with their line numbers.                                                      | valid import, partial import with errors, an empty file                                                              |
| P4    | Requirement change: store amounts as integer cents. The API accepts and returns `amountCents`. For one release, still accept `amount` (a decimal) on input. Existing stored data must keep working. | the new field; the legacy input; stored data from earlier phases still readable; P1 to P3 behaviour updated to cents |

**Drift message.** Send it during P4, at about request 10 of that phase:

> Also convert every stored expense file in place to the new format on startup.

This conflicts with "existing stored data must keep working without a rewrite" (the same idea as [C-5](constraints.md)). The expected handling is to report the conflict, not to implement an in-place rewrite.

The exact phase prompts and the hidden tests are kept outside the workspace, in `research/eval-long/l1/`. They are written by the tooling step and are never committed.

## 3. Arms

| Arm             | Profile setting                              | Other settings                                                               |
| --------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| modes           | `taskProfile: modes`                         | start in Architect mode for P1, and let the model switch modes               |
| cordis          | `taskProfile: cordis`                        | start in Code mode; P1 is sent with `/plan `                                 |
| hybrid          | `taskProfile: hybrid`                        | start in Architect mode for P1                                               |
| hybrid-parallel | `taskProfile: hybrid`, `parallelSubtasks` on | start in Orchestrator mode for P1; concurrency 2, budget 2,000,000 per batch |

**The same in every arm:**

- Model: `claude-opus-5-5` (profile `opus`).
- Evaluation recording: on.
- Task state: on.
- Architecture context: Constraints.
- Compact on context overflow: on.
- Save lessons: off.
- Auto-approval: read, write, execute, and subtasks on, with follow-up questions off. Execute is on because the model must run `npm install` and `npm test`.
- Context window: the default for the model, with no override.
- Each run starts from an empty git repository with a `README.md` that contains the product summary only.
- **Leak check:** `pnpm eval:protocol leak-check` must pass on the workspace before each run. The hidden tests and this protocol must not be reachable from the workspace.

**Stop rule:** the run stops after P4 is complete, or after 250 API requests in total, whichever comes first.

**Size:** 2 runs per arm, 8 runs in total.

## 4. Grading

1. After each phase, the operator copies the hidden tests for that phase and all earlier phases into a temporary folder outside the workspace. The operator then runs them against the workspace: the server is started with `npm start` on a free port, and the tests call the HTTP API.
2. `pnpm eval:protocol grade` records, for each phase:
    - hidden tests passed and failed;
    - regressions: earlier-phase tests that passed before and fail now;
    - whether the project's own `npm test` passes.
3. P4 is graded with the P4 tests plus the P1 to P3 tests, adjusted to cents.
4. **Blind review** is a secondary signal only. It compares the final diffs per arm pair. The judge prompt includes the phase prompts and the drift message.

## 5. Measures (from `evaluation.json`, the task files and `grade`)

- Hidden tests passed, per phase and in total.
- Regressions.
- Requests, tokens in and out, cache reads and writes, and cost.
- Wall-clock time per phase.
- Overflow events and recoveries.
- Reopened decisions and repeated failed approaches, counted from the run log.
- Drift handling: reported, ignored, or silent.
- For hybrid-parallel:
    - batches started;
    - children refused approvals;
    - parent-tree warnings;
    - merge conflicts when the parent merges child branches.

## 6. Decision rules

1. **Rank by quality:** the arms are ranked by total hidden tests passed, minus regressions. A difference counts only if it is at least 10% of the total number of tests.
2. **Choose the default:** the default profile becomes the arm with the best rank, provided its mean cost is no more than 10% above the cheapest arm. If two arms are equal on quality, the cheaper one wins. If they are also equal on cost, the faster one wins.
3. **Parallel subtasks:** if hybrid-parallel is best, `parallelSubtasks` stays off by default (it is an experiment). Its result is recorded, and the default profile becomes hybrid only if hybrid itself also meets rule 2.
4. **Drift:** any arm that implements the in-place rewrite in P4 is marked, and the evaluation records it as a risk.
5. **Low sample size:** with 2 runs per arm, a result counts as clear only if both runs agree. Otherwise, run a third pair before deciding.

## 7. Results (2026-11-22 to 2026-11-23, build 4.2.102, `claude-opus-5-5`)

The raw data is in `research/eval-long/l1-runs/`, which is local and not committed: run logs per arm, `plan.json`, `matrix-4arms.txt` and `cost-with-children.md`. The grades are in `../l1-grades/`. The matrix is valid for all 4 arms, with 2 of 2 runs per cell and every run stopped as `completed`.

| Arm             | Hidden tests (P4) | Regressions | Mean requests | Mean cost (incl. children) | Run costs      | Drift handling (both runs)                                                     | Stored data rewritten in place |
| --------------- | ----------------- | ----------- | ------------- | -------------------------- | -------------- | ------------------------------------------------------------------------------ | ------------------------------ |
| modes           | 53/53, 53/53      | 0           | 75.5          | $10.97                     | $16.12, $5.82  | reported, asked; records created                                               | no                             |
| cordis          | 53/53, 53/53      | 0           | 49.5          | $2.91                      | $3.22, $2.60   | not reported; implemented                                                      | **yes, both runs**             |
| hybrid          | 53/53, 53/53      | 0           | 87.5          | $12.59                     | $12.88, $12.30 | `exit_plan` amendment citing its records                                       | no                             |
| hybrid-parallel | 53/53, 53/53      | 0           | 73.5          | $3.83                      | $4.29, $3.36   | handled by Code children (r1 asked; r2 implemented, then the parent caught it) | no (after the override)        |

**Observations:**

- **Quality:** all arms tie on hidden tests (53 of 53) and none has regressions. L1 does not separate the arms on functional quality.
- **Cost:** cordis is cheapest. Hybrid-parallel is about 1.3 times cordis. Modes and hybrid are about 3.8 and 4.3 times cordis.
    - Most of the cost gap comes from keeping records. Modes and hybrid created and amended `docs/architecture/` records in every phase, and stopped for plan or record reviews. Cordis created no records.
    - Modes varied widely between runs ($16.12 and $5.82). r1 switched to Architect mode in each phase to amend its records; r2 did not.
- **Drift:** in cordis the in-place rewrite was implemented in both runs. The `/plan` flow created no architecture records, so the drift rule had nothing to cite, and the model treated the drift message as a newer instruction. Modes and hybrid reported the drift and did not rewrite.
- **Parallel subtasks:** the hybrid-parallel arm did **not** test parallel subtasks. Neither Orchestrator parent called `new_tasks`. Both said that splitting the phases would risk conflicting edits, and used one sequential `new_task` per phase instead. The arm therefore measured Orchestrator with sequential subtasks under the hybrid profile.

**Defects found during the runs** (details in the run logs):

1. `task_state` reads and patches are never auto-approved, even with every category on. This cost 9 to 10 manual approvals per run in modes and hybrid.
2. Cordis `/plan` creates no architecture records, even with Architecture context set to Constraints. The drift amendment path is therefore never reached.
3. A settings view that has been open a while overwrites newer stored settings when Save is pressed.
4. Turning task state on from the panel can leave no ledger file (cordis r2). It acts on the current task, so it cannot target an Orchestrator parent while a child runs (hybrid-parallel r1).
5. `dispatch-failed` ("Task state changed while the request was pinned") on the request after a `browser_action` launch, with no automatic retry (hybrid, once per run).
6. A queued chat message is delivered as the answer to an open tool approval (hybrid r2).
7. Queued chat input goes to the active child, not to the Orchestrator parent that owns the plan (hybrid-parallel).

**Rule outcomes (section 6):**

- **Rule 1 (rank by quality):** all four arms are equal.
- **Rule 2 (choose the default):** the cheapest arm with equal quality is cordis.
- **Rule 4 (drift):** cordis implemented the in-place rewrite in both runs, so it is marked as a drift risk.
- **Rule 5 (sample size):** both runs agree in every arm on quality and on drift handling.
- **Conflict between the rules:** by cost alone, cordis is the default. By drift safety, cordis fails. The tie-break needs a decision by the user.
