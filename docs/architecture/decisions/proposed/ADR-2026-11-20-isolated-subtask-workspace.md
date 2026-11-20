# ADR-2026-11-20-isolated-subtask-workspace: Optional git worktree for a subtask

Status: proposed
Last-verified: 2026-11-20
Paths: src/core/tools/NewTaskTool.ts, src/core/webview/worktree/**, src/services/checkpoints/**

## Problem

`new_task` takes no working directory, so a child task works on the parent's files and the same checkpoint history while the parent waits ([R-7](../../risks.md)). Evidence:

- `src/core/tools/NewTaskTool.ts` has no `cwd` parameter, and `src/core/task/Task.ts` never refers to a worktree (checked 2026-11-20).
- Worktree create, list, switch and delete exist only as user actions in `src/core/webview/worktree/handlers.ts:131`.
- In the 2026-11-18 evaluation, every run needed a separate snapshot made by hand. S1 attempt 2 was invalid because the model saw the protocol through `git diff` (evaluation run log).

Harness² runs each candidate in its own folder (`research/harness2/src/harness2/core/recursion.py`, `_roll`). Each improver session gets a fresh copy of its evidence (`core/proposer.py`, `Proposer.call`). Roo cannot run two independent attempts at the same change without this kind of isolation.

## Proposal

- Add an optional `isolation: "worktree"` parameter to `new_task`, available only when the extension host runs in `ExtensionMode.Development` ([ADR-2026-11-20-feature-gating-evaluation-and-lessons](../accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md)).
- With the option set:
    1. Create a git worktree from the parent's `HEAD` on a new branch `roo/subtask/<childTaskId>`, next to the workspace, using the existing worktree handlers.
    2. Run the child task with that worktree as its working directory.
    3. On completion, return the branch name and `git diff --stat` in the handoff. The child's changes are not applied to the parent.
    4. The parent, or the user, reviews and merges the branch. Roo never merges on its own.
    5. Remove the worktree only after the user approves.
- Checkpoints: the shadow repository must be keyed by the worktree path, so child checkpoints never mix with the parent's. Confirm this in `src/services/checkpoints/ShadowCheckpointService.ts` before implementation.
- Without the option, subtasks behave exactly as now.
- Uncommitted parent work is not copied into the worktree. The tool result states this.

## Alternatives considered

- **Copy the workspace folder.** Rejected: slow for large repositories, and it does not give a reviewable branch.
- **Run subtasks in parallel in the same workspace.** Rejected: they would overwrite each other's edits.
- **Turn it on for all users now.** Rejected: the merge step and checkpoint keying are not designed or tested yet.

## Acceptance criteria

- The parameter is not in the tool schema in a production extension host. A test proves this.
- A child created with isolation writes only inside its worktree. After it completes, the parent's working tree is unchanged.
- Child checkpoints are stored apart from the parent's.
- The handoff contains the branch name and diff stat.
- No existing task data changes ([C-5](../../constraints.md)). No extra service is needed ([C-1](../../constraints.md)).

## Risks

- Disk use: one worktree per isolated subtask. Mitigation: remove after approval.
- `node_modules` and build output are not present in a new worktree, so tests in the child may need an install first.
- Without uncommitted parent changes, the child can work from an outdated state.
