# 10. Quality requirements

Format: [`RECORD-FORMAT.md`](RECORD-FORMAT.md). All goals below were confirmed by the user on 2026-11-20.

### Q-REL-1: Task history survives upgrades and rollbacks

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task-persistence/**, src/core/task/model-operation/**

Quality property: #reliable

Scenario: A user upgrades the extension and reopens an older task. The task opens with its full history and no stored file is rewritten. Related: [C-5](constraints.md).

### Q-REL-2: Overflow recovery is bounded

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/context-management/**, src/core/condense/**

Quality property: #reliable

Scenario: The provider rejects a request for context size. Roo reduces context at most once and retries at most once. If that fails, Roo stops and shows the reason. It never loops. Related: [C-6](constraints.md).

### Q-REL-3: Recovery events are reversible

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/context-management/context-recovery.ts

Quality property: #reliable

Scenario: After compaction or truncation, the user selects Recover in new branch. Roo restores the exact pre-event history from the saved snapshot ([`../context-recovery.md`](../context-recovery.md)).

### Q-SEC-1: Repository content is lower-trust data

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/services/memory/**, src/services/task-state/**

Quality property: #secure

Scenario: Injected context (memory, ledger, architecture records) contains text that looks like an instruction. The model receives it labelled as data; system, mode, and user instructions keep precedence.

### Q-SEC-2: Secrets are not exposed

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13

Quality property: #secure

Scenario: A command or log contains a credential (for example a remote URL with a token). Roo and its agents do not print or persist it in task state or release notes.

Environment inheritance check (2026-11-20, from the Harness² pattern of removing credentials before launching agent subprocesses):

- **MCP stdio servers:** `McpHub` starts them with `getDefaultEnvironment()` from the MCP SDK, which passes only a fixed allowlist (on POSIX: `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`), plus the `env` block the user writes in the server config. `${env:NAME}` placeholders are resolved only where the user writes them. No change needed.
- **Provider keys:** Roo keeps them in VS Code secret storage, not in `process.env`. No subprocess receives them from Roo.
- **Terminal commands** (`ExecaTerminalProcess`, the VS Code terminal): commands inherit the full environment of the VS Code process, like a terminal the user opens. If VS Code was started with a credential in its environment, a command such as `env` can print it into the task history. This is accepted: removing variables would break user commands that need them (for example cloud CLI credentials). A possible future option is an opt-in list of variable names to remove before a command runs.

### Q-USE-1: Mode changes keep the model

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/webview/ClineProvider.ts

Quality property: #usable

Scenario: The user changes the mode of an open task. The task keeps its provider profile and model ([`../mode-model-selection.md`](../mode-model-selection.md)).

### Q-EFF-1: Context cost stays predictable

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task/Task.ts

Quality property: #efficient

Scenario: In a long task, injected context blocks are re-sent only when their digest changes, so prompt-cache reuse is kept.

Evidence ([evaluation 2026-11-18](evaluation-2026-11-18.md), one sample per run):

- **Cache hit rate:** 93.7% to 94.6% in the S1 and S2 runs, with Architecture context set to Off, Index, Constraints or Full.
- **Overflow recovery:** verified on 4.2.80 with a 64k context window override, with 0 recovery failures.
    - **Summaries:** verified (S3).
    - **Pruning:** verified (S3P). It avoided one of three summaries, and summary cost fell from $0.61 to $0.15.
    - **Image offload:** verified on 4.2.85 (live check C3, `opus-64k`). Three images were replaced by placeholders and saved as files; condense still followed. Since 4.2.86 the condense row shows the offload count.
    - **Note (2026-11-20):** these checks used a 64k context window override, and before 4.2.95 that override also triggered recovery before sending. From 4.2.95 recovery runs only after a provider rejection ([C-6](constraints.md)), so future overflow checks use a fault proxy.

### Q-EFF-2: Cordis profile costs no more than the modes profile

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/api/preview-runtime.ts, src/core/tools/ExitPlanTool.ts, src/core/task/Task.ts

Quality property: #efficient

Scenario: The same planned feature request (evaluation scenario S2) runs with the Cordis profile and with the modes profile, on the same build, model and settings. Over at least two matched samples per provider, the Cordis profile uses no more API requests, input tokens or cost than the modes profile, with an equal outcome under blind review. Related: [ADR-2026-11-19-keep-cordis-profile-widen-experiment](decisions/accepted/ADR-2026-11-19-keep-cordis-profile-widen-experiment.md), [R-6](risks.md).

Evidence: five Opus samples on 4.2.78 to 4.2.84 (Cordis 26% lower total cost, but more expensive in r5). The samples mixed builds and were scored by the operator, not blind ([R-6](risks.md)).

Evidence (2026-11-21, 4.2.97, two Opus pairs, blind review): Cordis cost 6% less and used 11% fewer input tokens, which is within the 10 percent equality band for cost. The blind judge preferred the modes diffs in both pairs. This goal is not met with an equal outcome in that sample. See section 9 of the [evaluation](evaluation-2026-11-18.md). A rerun with at least 4 Opus pairs on 4.2.98 or later is needed before a decision.
