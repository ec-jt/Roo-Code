# ADR-2026-11-20-isolated-subtask-workspace: Shared or isolated workspace for each subtask

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/tools/NewTaskTool.ts, src/core/webview/worktree/**, src/services/checkpoints/**

## Problem

A subtask can only share its parent's workspace today ([R-7](../../risks.md)). Sharing is correct for many subtasks, but there is no way to isolate one when the requirements call for it. Evidence:

- `src/core/tools/NewTaskTool.ts` has no workspace parameter, and `src/core/task/Task.ts` never refers to a worktree (checked 2026-11-20).
- Worktree create, list, switch and delete exist only as user actions in `src/core/webview/worktree/handlers.ts:131`.
- In the 2026-11-18 evaluation, every run needed a separate snapshot made by hand. S1 attempt 2 was invalid because the model saw the protocol through `git diff` (evaluation run log).

Harness² runs each candidate in its own folder (`research/harness2/src/harness2/core/recursion.py`, `_roll`). Roo cannot run independent attempts at the same change without some form of isolation.

The user decided (2026-11-20) that a subtask can either be isolated or share the workspace, depending on the requirements.

## Decision

Add a `workspace` parameter to `new_task` with two values. The parent chooses it for each subtask from the requirements. The user sees the choice in the `new_task` approval.

| Value              | Behaviour                                                                                                                                                                                | Choose when                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared` (default) | The child works in the parent's workspace folder, on the same files and checkpoints. This is the current behaviour.                                                                      | The child continues the parent's work and the parent builds on its changes. The child needs the parent's uncommitted state, installed dependencies or build output. The child only reads or investigates.                                                                                                     |
| `isolated`         | The child works in a new git worktree created from the parent's `HEAD`, on the branch `roo/subtask/<childTaskId>`. Its changes return as a branch and a diff, not applied to the parent. | The child tries an alternative that may be discarded. Several children try independent approaches to the same change, as in the harness loop or evaluation arms. The parent's working tree must not change. The child must not see the parent's uncommitted files, for example for leak-sensitive evaluation. |

Rules for `isolated`:

1. Roo creates the worktree with the existing `worktreeService` from `@roo-code/core` (the service behind `src/core/webview/worktree/handlers.ts`) and runs the child in it. The worktree is created in `ClineProvider.performDelegation`, before the parent is closed, so a failure leaves the parent unchanged. `.worktreeinclude` files are not copied into subtask worktrees.
2. On completion, the handoff contains the branch name and `git diff --stat`.
3. The parent, or the user, reviews and merges the branch. Roo never merges on its own.
4. Roo removes the worktree only after the user approves.
5. If the workspace is not a git repository, or the worktree cannot be created, `new_task` fails with the reason. It never falls back to `shared`, because that would break the isolation the parent asked for.
6. Uncommitted parent work is not copied into the worktree. The tool result says so.
7. The checkpoint shadow repository is keyed by the worktree path, so the child's checkpoints never mix with the parent's. Confirm this in `src/services/checkpoints/ShadowCheckpointService.ts` before implementation.

The tool description gives the selection guidance from the table above. The default stays `shared`, so existing prompts and modes behave as now.

Gating: development mode only at first ([ADR-2026-11-20-feature-gating-evaluation-and-lessons](../accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md)). In a production host, the parameter is not in the schema and every subtask is `shared`. Widening to all users needs a separate decision after the merge step has been used in practice.

## Alternatives considered

- **Always isolate subtasks.** Rejected: most subtasks build on the parent's state, and the parent would have to merge every child.
- **Always share (status quo).** Rejected: independent attempts and leak-sensitive work cannot run safely.
- **Copy the workspace folder instead of a worktree.** Rejected: slow for large repositories, and it does not give a reviewable branch.
- **Fall back to shared when the worktree fails.** Rejected: the parent chose isolation for a reason, and a silent fallback hides that it was not met.

## Consequences

### Acceptance criteria

- Without the parameter, and with `shared`, behaviour is unchanged. Existing subtask tests pass.
- With `isolated`, the child writes only inside its worktree. After it completes, the parent's working tree is unchanged, and the handoff has the branch name and diff stat.
- An `isolated` request outside a git repository fails with a clear reason and creates no child.
- Child checkpoints in `isolated` mode are stored apart from the parent's.
- In a production extension host, the parameter is not in the tool schema. A test proves this.
- No existing task data changes ([C-5](../../constraints.md)). No extra service is needed ([C-1](../../constraints.md)).

### Risks

- **Wrong choice by the model:** it may isolate a subtask that needed the parent's uncommitted state, or share one that should have been isolated. Mitigation: the selection guidance in the tool description, and the user sees the choice in the approval.
- **Disk use:** one worktree per isolated subtask. Mitigation: remove after approval.
- **Missing dependencies:** `node_modules` and build output are not in a new worktree, so the child may need an install first.
- **Outdated base:** without uncommitted parent changes, the isolated child can work from an older state.
- **Workspace boundary (implemented in 4.2.96):** file tools treat the worktree root as inside the workspace for an isolated task only, through `getTaskWorkspaceRoots()` passed to `isPathOutsideWorkspace()`. Shared tasks keep the editor folders as the only boundary.
- **Editor-folder services:** MCP servers, project modes (`.roomodes`) and codebase indexing still come from the editor folder, not the worktree.
- **Orphaned worktree:** if creating the child fails after the worktree exists, the worktree and branch remain. Remove them with the worktree UI.
