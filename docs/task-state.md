# Task state and reviewed continuation

Open **Task state** below the current chat task header. Opening the panel reads state; it does not create a ledger, enable continuation, or dispatch work. Task state requires the VS Code extension host. The standalone browser development fallback does not send or log task-state payloads.

## Enable and maintain task-local memory

1. Stop the task if it is active. If necessary, reopen it from History without resuming.
2. Open **Task state** and select **Refresh task state**.
3. Enter the goal and next action. Use **Records and evidence** to select a collection, enter an ID and text, and add the record to the draft.
4. Select **Enable task state** for a task with no ledger, or **Review and save state** for an existing ledger.
5. Review the exact payload in the native confirmation dialog before approving it.

Record edits and removals are incremental changes, not a replacement of every collection. Work items can reference evidence IDs. Their statuses, including “verified”, are **CLAIMED**. Runtime evidence is a receipt of an observation, not proof that acceptance criteria passed. Runtime evidence cannot be edited or removed in the panel.

Recalled data is sent to the configured model provider. Do not put credentials or secrets in task state. Recall is bounded to 24,000 characters; the ledger is bounded to 200 revisions and 4 MiB. Validation and capacity failures appear in the panel.

## Conflicts and history changes

The ledger head is the revision used to protect writes against concurrent changes. It can differ from the selected snapshot revision after a history rewind. **Stored revision and history coverage** shows both revisions, original-message counts, and history anchors.

On a failed or timed-out request, refresh before another change. Drafts remain available. Compare the draft with the stored state and explicitly review the retry. The panel never silently retries a write. A timeout does not cancel a native operation that is already in progress.

If a ledger exists but no snapshot matches the current history, the panel warns about incompatible history. Do not initialize again. An explicitly reviewed correction or policy change can start empty state at current history. Old revisions remain stored and are not automatically imported.

Collapsing the panel keeps drafts. Switching tasks or closing the webview clears unsaved drafts and detaches pending response handlers. Late responses cannot populate another task's panel.

## Bounded continuation and user checks

Continuation is disabled by default. The initial policy permits recall after opt-in and sets limits of 20 steps, 900,000 milliseconds, 100,000 tokens, and 3 no-progress steps.

1. Open **Recall and bounded continuation policy**.
2. Set limits and add at least one concrete acceptance-check description before enabling continuation.
3. Select **Review and save policy**, then review the native confirmation. Saving policy resets counters and user attestations.
4. Select **Arm next ordinary turn**, then approve the native review.
5. Send an ordinary message when ready to begin.

Arming does not dispatch work or approve tools. Existing mode restrictions, tool permissions, and approval controls remain in force. Use **Refresh task state** to see updated counters, the stop reason, and the terminal status: incomplete, blocked, awaiting approval, or completed according to user attestations.

**Record user check result** records a passed or failed result with a required note after native review. These checks are user-attested descriptions only. They do not execute shell commands or run automated tests. Work-item claims do not establish completion.

**Stop continuation** revokes continuation immediately but does not interrupt an in-flight tool or provider request. It remains available while another panel request is pending. **Disable recall and continuation** requires native review and retains stored data.

## Reviewed fresh context

1. Review state against the current transcript and its coverage.
2. Select **Review and save state**, even if the next-action text is unchanged.
3. Open **Reviewed fresh context** and select **Review and create fresh context**.
4. Approve the native review only if the saved state is sufficient.

Fresh context excludes the prior transcript from future provider context. It does not summarize that transcript. Original messages remain stored. This action changes context without dispatching work.

The current state must cover the current history, include a goal and next action, and fit the model budget with the retained newest interaction. Prepared replay, active requests/tools, unresolved tool pairs, and unsupported split-result batches are refused. If saving the new context fails, the live history is restored and dispatch closes because the on-disk outcome may be uncertain; the pre-change recovery snapshot is retained. Reopen and inspect recovery before proceeding.

## Verification limits

Task-state persistence and UI workflows have focused automated coverage. They have not yet been exercised end-to-end in a live extension host or under process crashes/power loss. Stale transaction locks can require manual storage recovery. Stored references are not automatically checked against current file contents; a runtime receipt proves receipt of a tool result, not that its findings remain valid. Continuation limits are enforced at dispatch/tool/completion boundaries, not by interrupting an operation already in flight. No executable acceptance-check runner is included.

## Fork, export, and model requests

A task without a ledger can explicitly fork reviewed state from another task in the same workspace. Enter the source task ID and exact selected snapshot revision. Existing destination ledgers cannot be overwritten by a fork.

**Export Markdown** displays a read-only text area. Focus it to select the content, then copy it using the normal clipboard shortcut. Exported content is not executed or interpreted as HTML.

Model task-state tool requests display the exact action, expected revision, and proposed operations in chat. Use the existing chat approval controls to allow or deny the request. These controls do not grant additional continuation or tool permissions.
