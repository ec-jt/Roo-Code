# Editing assistant responses

Use **Edit assistant response** below a completed assistant text response on the latest chat page. Change the text and select **Save without running**.

The save changes that assistant text in both the displayed conversation and the model history. It preserves later messages, timestamps, token/cost records, tool calls, tool results, and reasoning. It does not rewind files, rerun tools, send a user message, or start a model request. Later responses are not regenerated and can therefore contradict the edited text.

On the next request, Roo uses the edited local history and invalidates reusable provider response context from the edited turn onward. This is conversation-history editing, not assistant-prefill continuation. Normal context limits and provider formatting still apply. No live inference-provider validation has been performed for this feature.

## Availability

- Stop active work and reopen the task without resuming if Roo reports that the request or presenter is busy. A settled resume prompt can remain open while editing.
- Return to latest and foreground the task before editing. Historical pages remain read-only.
- Only complete assistant text with an exact, unambiguous model-history match is supported. The initial task prompt, reasoning, tool arguments, completion-tool results, and truncated UI previews are not editable through this control.
- Condensed or context-truncated turns, ambiguous legacy mappings, multi-text responses, and prepared replay tasks are rejected. Roo does not guess at a mapping or silently edit a summary instead.
- Saves compare the original text and task-instance identity to reject stale editors. The editor retains its draft on a reported save error. If acknowledgement times out, check the stored response before retrying.
- New editor labels currently use English.

## Persistence failures

API and UI histories use atomic barrier saves, but the two files are not a single filesystem transaction. Roo first creates an interruption marker and removes it only after both saves complete. On failure, it attempts to restore both original histories and blocks further dispatch in that task instance.

If an interrupted edit or incomplete rollback leaves `assistant-edit-pending.json` in the task directory, reopening the task remains blocked. Do not remove this marker merely to dismiss the error. Preserve the task directory, restore a consistent pair of API/UI history files from a known-good backup, and only then remove the marker before reopening. No automatic recovery interface is included.

Use a disposable test conversation or export a backup before editing important history. Editing assistant text does not grant tool permissions or disable existing approval checks.
