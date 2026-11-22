# ADR-2026-11-22-parallel-subtasks: Parallel subtasks in isolated worktrees

Status: accepted
Accepted-by: user
Last-verified: 2026-11-22
Paths: src/core/task/parallel/**, src/core/tools/NewTasksTool.ts, src/core/webview/ClineProvider.ts, src/api/dispatch-admission.ts, src/api/preview-runtime.ts, webview-ui/src/components/**

## Problem

Subtasks run one at a time:

- [`ClineProvider`](../../../../src/core/webview/ClineProvider.ts) holds one task stack with one current task, plus a single background slot ([`RunningTaskMonitor`](../../../../src/core/webview/RunningTaskMonitor.ts)).
- `new_task` hands control to the child, and the parent waits.

The user asked (2026-11-22) for Roo to run tasks in parallel as part of the hybrid build.

The pieces needed already exist:

- isolated git worktrees for subtasks ([ADR-2026-11-20-isolated-subtask-workspace](../accepted/ADR-2026-11-20-isolated-subtask-workspace.md));
- the dispatch runtime's admission interface, with `admit`, `settle`, leases and budget refusal codes ([`dispatch-admission.ts`](../../../../src/api/dispatch-admission.ts)). Today it grants every request ([R-5](../../risks.md)).

## Decision

1. **Tool.** A new tool, `new_tasks`, is offered only:

    - in Orchestrator mode or in `cordis` or `hybrid` tasks;
    - when the experiment `parallelSubtasks` is on (default off).

    It takes 2 to 4 children, each with a mode and a message. Every child uses `workspace: isolated`. The user approves the batch once.

2. **Pool.** `ParallelTaskPool` (`src/core/task/parallel/`) runs the child `Task` instances outside `clineStack`.
    - The parent stays on the stack and waits.
    - Children are saved as ordinary history items with `parentTaskId` (additive, [C-5](../../constraints.md)).
3. **No asking.** Children cannot ask the user.
    - A tool that the existing auto-approval settings would approve runs.
    - Any other tool, follow-up question or mode switch is refused with a tool result. The result tells the child to finish and report what needs approval.
    - No approval is ever granted that a normal task would not get ([Q-SEC-3](../../quality.md)).
4. **Admission is enforced by the runtime.** For parallel children, the runtime is used on every provider, not only Anthropic (a change to [R-5](../../risks.md)). It enforces:
    - **Concurrency limit:** at most N requests in flight per batch. The default is 2; a setting allows 1 to 4.
    - **Shared token budget:** one budget for the batch, with a default of 2,000,000 input plus output tokens. A setting can change it. When the budget is exhausted, the remaining children stop with `budget-denied`.
5. **Result.** When all children have stopped, the parent receives one tool result. For each child it gives:

    - the stop reason and summary;
    - the branch, `git diff --stat` and uncommitted files;
    - the refused approvals.

    Nothing is merged automatically.

6. **UI.** Background activity lists the children: status, requests, cost, Stop, and Open (read only). Stopping the parent stops all its children. Strings are in all 18 locales.
7. **First-version limits:**
    - children cannot call `new_tasks`;
    - children cannot use the shared workspace;
    - children cannot ask questions.

## Alternatives considered

- **Pause a child and show its approval in the Background activity panel.** Deferred: it is more flexible but needs a larger UI change. Deny and report is safer for a first version.
- **Parallel subtasks in the shared workspace.** Rejected: the children would overwrite each other's edits ([R-7](../../risks.md)).
- **Anthropic only.** Rejected: hybrid and modes are used on other providers, and the admission logic does not depend on the provider.

## Consequences

### Acceptance criteria

- With the experiment off, `new_tasks` is not in any tool schema, and behaviour is unchanged.
- Two children run at the same time in separate worktrees. The parent receives both results, and the parent's working tree is unchanged.
- A tool that needs approval is refused in a child and is never run.
- With concurrency 1, requests from two children never overlap.
- An exhausted budget stops the children with `budget-denied`.
- Stopping the parent stops all its children, and each child records a stop reason.

### Risks

- **R-1:** this touches the task lifecycle and `Task.ask`. Build the pool and the ask policy first, alone and fully tested.
- **R-8 (new):** cost grows with parallel children. Mitigated by the shared budget and the concurrency limit.
- **R-9 (new):** child branches can conflict when merged. The parent or the user merges, and conflicts are reported, never resolved automatically.
- **Rate limits:** provider rate limits apply to the sum of all children. The concurrency limit is the first guard.

### Implementation notes (4.2.100, 2026-11-22)

- **Gate:** `isParallelSubtasksToolOffered()` in `src/core/task/cordis-profile.ts`. The tool is offered only when the experiment is on, the task is not a parallel child, and the task is in Orchestrator mode or uses the `cordis` or `hybrid` profile.
- **Approval:** `newTasks` uses the same auto-approval rule as `newTask` (`alwaysAllowSubtasks`). In addition, a task that already has a parent cannot start a batch.
- **Children:**
    - They run headless.
    - The non-interactive hook in `Task.askAndWait` only refuses. The capability policy refuses `new_task`, `new_tasks` and `switch_mode`.
    - Checkpoints are off, because each child's worktree branch records its work.
    - Tools that require the child to be the current task (task state, browser control) fail safely in children.
- **Open** shows a child's plain-text transcript in the read-only chat history document.
- **Known gap:** unlike `new_task`, `new_tasks` is not yet forced to be the only tool call in its turn. The rule is stated only in the tool description.
- **Budget:** the shared budget is checked before each request, so one request that is already running can go over it.
