# Backend model-operation protocol

## Scope and implementation boundary

This document defines the backend contract for regenerating a saved assistant response or switching the model for a live request. Both operations create a **new standalone branch task**. Neither operation changes the model of the source task in place or replays effects. A live request after completed durable tool exchanges may restart with those exchanges retained as context.

The shared schemas, request snapshot storage, normalization, tool admission, Task prefix helpers, [coordinator](coordinator.ts), and provider/message routing are implemented. The webview controls use the nested protocol described below. Historical regeneration uses Task's historical-quiescence helpers. Source detachment uses dedicated artifact-preserving disposal after the dispatch fence, rather than normal abort or destructive cleanup.

Source contracts:

- [Shared payload, status, and readiness schemas](../../../../packages/types/src/model-operation.ts).
- [Extension/webview transport types](../../../../packages/types/src/vscode-extension-host.ts).
- [Task readiness and lifecycle helpers](../Task.ts:506).
- [Snapshot and branch provenance storage](storage.ts).
- [Provider-neutral normalization and context budgeting](normalization.ts).
- [One-use tool admission](admission.ts).

## Transport

Operation requests carry the operation in a nested payload, not in the outer message's generic fields:

```json
{
	"type": "modelOperation",
	"modelOperation": {
		"operationId": "operation-unique-id",
		"kind": "regenerate",
		"taskId": "source-task-id",
		"instanceId": "loaded-source-instance-id",
		"revision": 12,
		"profileId": "saved-profile-id",
		"requestId": "selected-request-id",
		"confirmCurrentWorkspace": true
	}
}
```

Tool approval uses a separate nested payload:

```json
{
	"type": "modelOperationApproval",
	"modelOperationApproval": {
		"taskId": "branch-task-id",
		"instanceId": "loaded-branch-instance-id",
		"revision": 3,
		"approvalId": "pending-tool-approval-id",
		"approved": true
	}
}
```

Progress and outcomes use the nested status payload:

```json
{
	"type": "modelOperationStatus",
	"modelOperationStatus": {
		"operationId": "operation-unique-id",
		"status": "completed",
		"message": "Branch activated.",
		"taskId": "new-branch-task-id",
		"instanceId": "new-branch-instance-id",
		"revision": 1
	}
}
```

The revisions and identities above are illustrative. Clients must use current backend-issued values, never infer them from timestamps or row positions.

### Validation and identity

The [operation schema](../../../../packages/types/src/model-operation.ts:7) is strict: unknown nested fields are rejected. Operation, task, instance, and saved-profile identities must be explicit nonempty strings. The revision must be an explicit nonnegative safe integer. Do not default omitted identities to the active task, active profile, or current revision; outer transport fields cannot fill holes in the nested payload.

The schema accepts a boolean workspace confirmation and an optional request identity for both operation kinds. Coordinator validation is deliberately stronger:

- Workspace confirmation must be exactly true. It confirms use of the **current workspace**, not restoration of the filesystem that existed when the selected response was generated.
- Regeneration must supply a request identity. It must identify a genuine assistant UI row whose [message fields](../../../../packages/types/src/message.ts:262) are `type: "say"` and `say: "text"`, and an API-history assistant message with the same [request identity](../../task-persistence/apiMessages.ts:14). A request-start marker, tool row, user row, fabricated identity, or snapshot file alone is insufficient evidence.
- Switching targets the durable snapshot of the currently live request. If a request identity is supplied, it must match that live request; it is not permission to select another historical request.
- Source task identity, loaded instance identity, and revision must all match the current backend object. A persisted task ID alone cannot authorize an operation on a reloaded instance.

The [state exposed as ExtensionState.modelOperation](../../../../packages/types/src/vscode-extension-host.ts:345) is the Task's **live readiness**, obtained from [Task.modelOperationState](../Task.ts:506). It includes source identity, revision, optional current snapshot/profile identity, readiness, an optional reason, mandatory-tool-approval policy, and any pending approval. It is not a historical-row eligibility index. A blocked live switch does not prove that a historical prefix is invalid, and live readiness does not prove that a historical transition is safe.

## Source eligibility: standalone graph HOLD

Only the currently loaded standalone task is eligible. The coordinator must not load another task, walk to another graph node, or implicitly resume a historical task to satisfy the request.

The graph policy is **HOLD**: block any parent, child, root linkage, active or persisted delegation relationship, pending delegation, paused delegation, or waiting-parent state. Check both the loaded Task and relevant persisted graph metadata. A root task with children is not standalone merely because it has no parent. Neither branch creation nor activation may mutate graph links, complete a delegated child, or wake a waiting parent.

### Live switching

Use [Task.getModelOperationEvidence()](../Task.ts:584) and live readiness. Admission/execution evidence is scoped to the current response, not the whole task. Current-response admitted or executed tools remain blocked: wait for settlement and retry at the next request. There is no mid-tool interruption, synthetic result, queued automatic switch, or effect replay.

The next request can become ready only after the prior stream, presenter, approvals, edits, terminals, and usage collection have settled. Settlement is captured before presenter state is reset. Both persisted history and outgoing input must have complete validated tool pairs, including a result for every tracked admitted call. Exact history and request snapshot writes must succeed. Publication synchronously rechecks history identity, counters, pending work, and the request revision before clearing counters. Request advancement or admission during asynchronous preparation prevents stale activation. Overlapping requests cannot cancel an outstanding approval or erase its evidence.

Closed/aborted tasks, delegation, active terminals, pending approvals or asks, an active presenter/edit, and absence of a durable validated snapshot still block switching. Prior completed calls/results do not block the next request and are copied as context, never dispatched as tools. The legacy executed-continuation evidence flag remains false: it refers to resuming effects within the current response, not restarting a later validated request.

After all preflight work and branch preparation, use [Task.stopForModelOperation()](../Task.ts:691) with the expected revision. It validates before its first asynchronous wait, closes dispatch, advances the revision, cancels approval and the request, and waits for request loops, requests, usage collectors, and the presenter to drain. Its current timeout is five seconds. A timeout leaves the source fenced and is a failure, not permission to activate a replacement or share the old parser.

### Historical regeneration

Validate the selected UI/API assistant pair and read its durable pre-response snapshot. Historical regeneration needs a **dedicated Task historical quiescence helper** that can prove safe source detachment without requiring live-switch readiness and without writing source history or artifacts.

The required capability is [HistoricalModelOperationTask](coordinator.ts:23): a synchronous historical block-reason getter and an asynchronous historical stop method taking the expected revision. The stop method must validate quiescence, close dispatch, cancel pending approval/timers and increment the revision exactly once, without source writes. These helpers are implemented on Task. They permit a loaded, initialized, quiescent history view even when its past requests executed tools. Active execution must finish or be stopped safely before reopening the task from history without resuming. Fail closed when this capability is unavailable. Do not substitute live readiness, inspect private counters from the coordinator, call a normal abort, or treat a completed-looking row as proof of quiescence. Historical completed tool pairs can be context in a validated snapshot; this does not authorize replay or continuation of their effects.

## Snapshot and branch semantics

A [request snapshot](storage.ts:19) is captured durably immediately before provider dispatch and before the selected assistant response. It contains the effective API input prefix, UI prefix, original system prompt, source task/request identities, creation time, and optional source provider/model metadata. The API prefix ends in the original user input, including completed tool results when applicable. It must not contain the selected response.

Regenerate means send the selected request's original input again with the chosen saved profile. Switch means send the current live request's original input again with that profile. Neither means append a synthetic instruction such as "continue", reconstruct input from the selected answer, or keep streaming partial text as branch input.

The immutable snapshot preserves the original request data. The branch uses a detached, provider-neutral normalization of that data, so provider-private reasoning and metadata are not promised byte-for-byte replay. It retains the captured system prompt and original input content supported by normalization, rather than appending fresh environment details or reparsing the original input as a new user task.

Normalization applies once to the imported prefix. Subsequent target-generated reasoning/signatures stay in native history and pass through the selected provider's adapter. Replay validation is separate from the outgoing representation; repeated requests must not strip target-native continuation metadata. Gemini adapters retain unsigned historical calls using their existing request-only signature sentinel; empty results remain paired. Mistral adaptation retains mixed user context and derives invalid call IDs from their full value rather than truncating a shared prefix. These transformations do not invent reasoning or execute tools, and adapter tests are not a guarantee that every remote model accepts every historical prefix.

The branch prefix excludes the selected response and everything after it, including live partial output. Preparation also removes request-start UI markers from the copied prefix. This discard occurs **only in the branch**. The operation does not truncate, rewrite, or delete the original UI/API histories or command-output artifacts. Natural in-flight source writes that occur before the dispatch fence may still finish; "original unchanged" is not a guarantee that an actively running source was frozen before the operation began.

## Saved profile and context preflight

Resolve only the explicitly requested saved profile through [getProfile({ id: profileId })](../Task.ts:580). Missing or invalid profiles block the operation. There is no fallback to profile name, the globally active profile, or arbitrary settings supplied by the caller. Pin the saved profile on the branch; never globally activate it or broadcast a global profile change as part of the operation.

Before stopping the source:

1. Read and validate the selected snapshot and its source identity.
2. Normalize its API prefix using [normalizeSnapshotMessages()](normalization.ts:126), without modifying the snapshot or source histories.
3. Resolve the target model's context window and explicit output reserve from the saved profile.
4. Budget the normalized messages, captured system prompt, complete serialized tools, and other request material using [assertContextFits()](normalization.ts:234).
5. Reject unsupported content, malformed tool pairing, unavailable limits, or excessive context rather than truncating or compacting the prefix.

Normalization preserves text, tool IDs/names/plain-JSON inputs, and text results with their error flags. It removes recognized thinking/redacted-thinking/reasoning blocks and provider metadata. Unsupported blocks, including images and non-text tool results, fail closed. Every tool call ID must be unique and have exactly one matching result in the immediately following user message; incomplete, orphaned, duplicate, or wrong-batch results are rejected. No roles, IDs, results, or missing text are fabricated.

The budget counts UTF-8 JSON bytes as context units, adds structural overhead (1024 base, 64 per message, 32 per block including nested result text, and 256 when tools are present), then reserves output tokens. It is intentionally conservative, not a tokenizer or a bytes-divided-by-four estimate. It may reject valid provider requests and is not a universal bound for every provider's framing.

Preparation is not the final context check. [Task dispatch validates again](../Task.ts:4788) with the actual request metadata and resolved output limits before saving the new request snapshot and contacting the provider. Prepared requests disable automatic compaction/retry that would silently alter the prefix. Provider context errors remain possible and must fail safely.

## Coordinator ordering and activation

Serialize model-operation processing **per provider instance**. This is the extension's task-owning provider, not a queue keyed only by model vendor. Revalidate a queued request when it reaches the front of the queue.

The required sequence is:

1. Strictly parse the nested request and validate current source identity, workspace confirmation, standalone graph policy, and operation-specific evidence.
2. Resolve the effective storage root and check the durable operation receipt. Reserve a new operation durably before branch effects; report running only for an accepted operation.
3. Load the saved profile and durable snapshot; complete normalization and conservative context preflight while the source is still intact.
4. Allocate a **new task ID** and construct an unstarted standalone branch with `startTask: false`. Do not attach parent, child, or root identities.
5. Await [prepareModelOperationPrefix()](../Task.ts:611). It verifies provenance, pins the profile, persists mandatory approval policy before branch histories, installs the normalized prefix, preserves the system prompt, and disables checkpoints. Do not expose or execute a partially prepared branch.
6. Recheck the current source object, task/instance identities, expected revision, workspace, and graph eligibility. For live switching, await the dedicated live stop helper; for historical regeneration, require the dedicated historical quiescence helper.
7. Recheck after quiescence. Account for the intentional revision advance made by the live stop helper; it does not excuse unrelated identity or workspace changes. Synchronously replace the source on the provider stack, with no intervening asynchronous gap between final validation and replacement. Do not invoke normal abort/remove flows.
8. Start only through [startModelOperationPrefix()](../Task.ts:675). No normal task start, history resume, delegation resume, or delegation entry point is permitted for this transition.
9. Durably record the outcome and publish completed with the **branch** task ID, instance ID, and current revision after activation. Publish refreshed live state as appropriate.

Recheck identity and workspace after asynchronous boundaries, including profile reads, snapshot/receipt I/O, preparation, and quiescence. Capturing a Task reference before an asynchronous wait is not sufficient. Stale state or an unavailable helper must fail closed; a prepared branch must not be activated against a different source or workspace.

[Task.dispose()](../Task.ts:2657) is not a write-free teardown: it schedules command-output cleanup and can revert an active diff. Normal abort also disposes and saves source messages. Neither is allowed for the source transition. A dedicated **write-free disposal helper** is required to release listeners and runtime resources without deleting artifacts, writing histories, reverting workspace effects, or reopening dispatch. The provider now calls the dedicated artifact-preserving disposal helper after the settled fence, then detaches the source and activates the branch. Historical stop advances the revision exactly once, just as live stop does.

## Durable receipts and storage

Use the **effective storage root**, including any custom storage setting, consistently for snapshots, provenance, and coordinator receipts. [Snapshot storage](storage.ts:162) uses these task-scoped paths:

```text
<effective-root>/tasks/<taskId>/model-operation/request-<requestId>.json
<effective-root>/tasks/<branchTaskId>/model-operation/branch-provenance.json
```

Existing storage validates identities, schemas, checksums, and pre-response boundaries. Exact immutable retries succeed; differing records at the same identity, corruption, or mismatched identities fail. JSON writes use [safeWriteJson()](../../../utils/safeWriteJson.ts:1); immutable publication uses a synced staging file and a no-overwrite hard link. There is no unsafe fallback when hard links are unsupported. Existing symlinks below the trusted root are rejected, but this is not a sandbox against concurrent hostile directory replacement. Checksums detect corruption, not malicious edits; Windows lacks the directory-fsync power-loss guarantee, and a crash may leave an ignored staging file.

Branch provenance records the operation kind/identity, source task/request identities, target saved profile, workspace, creation time, and mandatory tool-approval policy. It is not a delegation edge or a persisted grant of tool approval. It is stored separately from UI/API histories before exposing or executing the branch. New branches persist a branch-owned replay snapshot and record its request identity in provenance. Restoration uses that local snapshot and fails closed if it is missing/corrupt, without falling back to the source. Legacy provenance retains its exact source-snapshot lookup. Restoring either format restores the mandatory gate and fails closed on invalid provenance or workspace mismatch.

Branch preparation copies source command-output artifacts into branch-owned storage before publishing provenance. Copies are independent files, synced and published without overwrite; retries require identical content. Identity/path validation rejects symlinks, non-regular files, invalid names, changed sources, and collisions. Source deletion and branch-of-branch continuation therefore preserve new branches' replay input and command-output access without cross-task runtime lookup. All source command artifacts are copied, including ones outside the selected prefix. Limits are 1,000 artifacts, 128 MiB per artifact, 512 MiB total, and 10,000 directory entries; exceeding limits fails preparation, not truncates. A missing output directory is allowed and does not prove that historical artifact references still exist. Legacy branches are not implicitly migrated.

Ordinary branch unload retains command artifacts too. Disposal checks persisted provenance when initialization has not established the branch policy; unreadable provenance retains artifacts rather than risking deletion. Explicit task deletion still removes the task directory. Ordinary non-branch cleanup is unchanged.

The coordinator additionally owns durable operation receipts under:

```text
<effective-root>/model-operation/operations/<hash-of-operationId>.json
```

Hash the operation identity for the filename; never use a caller-controlled operation ID as a path segment. Preserve enough validated request identity and outcome in the receipt to distinguish an exact duplicate from an ID collision. These receipts are separate from the existing immutable snapshot/provenance records.

- Same operation ID and same request: return the existing outcome or known in-process status, without creating or starting a second branch.
- Same operation ID with different request data, or a hash/record identity collision: explicitly block; do not overwrite or reuse the receipt for the new request.
- A durable running receipt without its original active coordinator execution, including after restart: fail closed as interrupted. Do not rerun, resume, or infer success from an orphaned branch directory.
- Claims are published with an atomic no-overwrite hard link after an atomic JSON write and file flush. The containing directory is flushed on non-Windows platforms. Hard-link support is required; Windows has no directory-flush power-loss guarantee. Final statuses use atomic JSON replacement and flushing. Receipt I/O failure must not authorize an unrecorded retry. There is no automatic interrupted recovery.

Per-provider serialization and durable receipts serve different purposes: the queue orders local work; the receipt prevents duplicate effects across retries and restarts. A crash between branch activation and terminal receipt persistence can leave an ambiguous running receipt. Safety takes precedence over automatically completing that operation.

## Status semantics

The [status schema](../../../../packages/types/src/model-operation.ts:36) requires operation identity, status, and a message. Task/instance/revision fields are optional in the shared schema; completed coordinator responses must include the activated branch identity.

| Status    | Meaning                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| running   | The accepted operation is being processed, not that a new response has finished.                                                                          |
| completed | The prepared branch was activated and its dedicated start was invoked. Response generation may still be streaming, awaiting tool approval, or later fail. |
| blocked   | Validation, eligibility, stale identity, unavailable safety helper, collision, or another safety precondition prevents proceeding.                        |
| failed    | Preparation, persistence, quiescence, activation, or an interrupted execution could not complete safely.                                                  |

A blocked/failed result must not imply that all runtime changes were rolled back. Preparation can leave a branch directory, and a stop failure can leave the source fenced. Report the actual outcome without rerunning effects to repair it.

## Mandatory tool approval

Every branch tool call is subject to [ModelOperationAdmission](admission.ts:9), independently of ordinary asks and auto-approval settings. Partial tools must not reach handlers. Approval is one-use and bound to task, instance, revision, and the pending approval identity. It cannot be shared with another tool call, persisted as a grant, or carried to a newer revision. Delegation through the new-task tool is denied under this policy.

Route the approval transport **only** to [respondToModelOperationApproval()](../Task.ts:558). Do not forward it to ordinary ask responses or auto-approval handlers. Acceptance of a response means its identity matched; an accepted denial still does not execute the tool.

Malformed or stale approvals must produce an explicit blocked model-operation status, using the supplied valid nonempty approval identity as the status's operation identity for correlation. If the approval identity itself is missing or invalid, use an explicit backend-generated diagnostic correlation identity rather than inventing a successful approval or violating the status schema. Reject without consuming a different pending approval. Cancellation or a changed live identity invalidates the pending grant.

Completed historical tool results in a prefix are context only. No historical command, file edit, browser action, delegation, or other effect is replayed. A newly generated tool call is a new effect and requires its own approval, even if it resembles a past call. A later request can restart after validated durable settlement; neither operation resumes a tool handler or partially executed current response.

## Limitations and failure guarantees

- Legacy rows without stable request identities cannot be regenerated. Timestamps, text similarity, UI indices, or provider response IDs are not substitutes.
- Historical regeneration requires a quiescent loaded task. If an execution loop or presenter is active, safely stop it and reopen history without resuming; live readiness cannot replace the historical fence.
- Source detachment uses dedicated artifact-preserving disposal after the stop fence, removes provider lifecycle listeners and replaces the stack entry. It never invokes normal abort or command-output cleanup.
- No parent/child/root/delegation graph operations and no waiting-parent replay are supported.
- Webview controls use this backend protocol; backend eligibility checks remain authoritative even when a control is visible.
- Workspace confirmation does not undo edits or restore a historical checkout. No checkpoints or historical side effects are replayed.
- Original histories and artifacts are not rewritten by the operation, apart from natural in-flight source writes that may finish before the fence. Runtime dispatch may be stopped even if a later transition fails.
- Branch preparation or a subsequent stale check can leave an orphaned, unactivated branch. Do not activate it automatically or delete source data to compensate.
- Interrupted receipts are never automatically recovered or rerun, including when activation may have happened before the crash.
- Completion means branch activation, not successful model response completion. Later provider errors and tool denials remain independent outcomes.
