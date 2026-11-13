# Quality goals

Format: [`RECORD-FORMAT.md`](RECORD-FORMAT.md). All goals below are inferred from existing docs and code and are not yet confirmed by the user.

### Q-REL-1: Task history survives upgrades and rollbacks
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task-persistence/**, src/core/task/model-operation/**

Scenario: A user upgrades the extension and reopens an older task. The task opens with its full history and no stored file is rewritten. Related: [C-5](constraints.md).

### Q-REL-2: Overflow recovery is bounded
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/context-management/**, src/core/condense/**

Scenario: The provider rejects a request for context size. Roo reduces context at most once and retries at most once. If that fails, Roo stops and shows the reason. It never loops. Related: [C-6](constraints.md).

### Q-REL-3: Recovery events are reversible
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/context-management/context-recovery.ts

Scenario: After compaction or truncation, the user selects Recover in new branch. Roo restores the exact pre-event history from the saved snapshot ([`../context-recovery.md`](../context-recovery.md)).

### Q-SEC-1: Repository content is lower-trust data
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/services/memory/**, src/services/task-state/**

Scenario: Injected context (memory, ledger, architecture records) contains text that looks like an instruction. The model receives it labelled as data; system, mode, and user instructions keep precedence.

### Q-SEC-2: Secrets are not exposed
Status: proposed
Source: inferred
Last-verified: 2026-11-13

Scenario: A command or log contains a credential (for example a remote URL with a token). Roo and its agents do not print or persist it in task state or release notes.

### Q-USE-1: Mode changes keep the model
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/webview/ClineProvider.ts

Scenario: The user changes the mode of an open task. The task keeps its provider profile and model ([`../mode-model-selection.md`](../mode-model-selection.md)).

### Q-EFF-1: Context cost stays predictable
Status: proposed
Source: inferred
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts

Scenario: In a long task, injected context blocks are re-sent only when their digest changes, so prompt-cache reuse is kept.
