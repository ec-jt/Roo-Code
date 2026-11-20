# 2. Architecture constraints

Format: [`RECORD-FORMAT.md`](RECORD-FORMAT.md). Entries marked `Source: inferred` are not confirmed by the user.

### C-1: VS Code extension host runtime

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/\*\*

The extension runs in the VS Code (or code-server) extension host. It uses only the `vscode` API and Node built-ins available there. It must not require a separate long-running service.

### C-2: Node 20 toolchain

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: package.json, .nvmrc

Builds and tests use Node 20.x (`.nvmrc` pins 20.19.2).

### C-3: pnpm and Turbo monorepo

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: package.json, pnpm-workspace.yaml, turbo.json

Dependencies are managed with pnpm 10.8.1 workspaces. Build order is managed with Turbo. Shared types live in `packages/types`.

### C-4: Webview isolation

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: webview-ui/**, src/core/webview/**

The webview UI has no direct file system, network, or provider access. All side effects go through typed messages to the extension host.

### C-5: No task-data migration

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/core/task-persistence/**, src/core/task/model-operation/**

Changes never list, read in bulk, migrate, rewrite, or delete existing task data in VS Code global storage. New formats must be additive and readers must accept the old format.

### C-6: Overflow-only compaction

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/context-management/**, src/core/condense/**, src/core/task/Task.ts

Context reduction runs only after the provider rejects a request for size. There is no proactive threshold. One retry after recovery, then stop. See [ADR-2026-11-13-overflow-only-context-recovery](decisions/accepted/ADR-2026-11-13-overflow-only-context-recovery.md).

This applies to every profile, including profiles with a context window override (user, 2026-11-20). The 4.2.90 to 4.2.94 check before sending for override profiles was removed in 4.2.95. Size checks inside the one allowed recovery (4.2.89: shorten kept tool results, refuse to send a prompt that still exceeds the window) are part of recovery and are allowed.

### C-7: User-visible strings are localized

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13
Paths: src/i18n/**, webview-ui/src/i18n/**

New user-visible strings need keys in all 18 locales of the extension and webview.

### C-8: No disabled lint rules

Status: accepted
Accepted-by: user
Last-verified: 2026-11-13

Lint rules are not disabled without explicit user approval.
