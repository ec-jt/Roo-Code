# ADR-2026-11-13-mode-switch-model-preservation: Mode changes keep the task's model

Status: accepted
Accepted-by: user
Last-verified: 2026-11-20
Paths: src/core/webview/ClineProvider.ts, src/core/webview/webviewMessageHandler.ts

## Problem

Changing the mode of an open task used to switch to the mode's associated provider profile. This silently replaced the model and dropped unsaved overrides in the middle of a task.

## Decision

Changing the mode of an open task changes instructions and tools only. The task keeps its active configuration. Mode-associated profiles are defaults only when no task is open. Delegated children inherit a copy of the parent's active configuration. Introduced in 4.2.51 ([`../../../mode-model-selection.md`](../../../mode-model-selection.md)).

## Alternatives considered

- Keep per-mode profile switching: surprising model changes and cost changes.
- Ask on every mode change: adds friction for the common case.

## Consequences

### Acceptance criteria

- Mode change in an open task does not change provider or model.
- Child tasks inherit the parent's active configuration.

### Risks

- Users who relied on per-mode models must select the profile explicitly. Related: [Q-USE-1](../../quality.md).
