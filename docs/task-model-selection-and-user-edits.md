# Model selection and user-message editing

## Change the model during a task

Open the model-profile selector in the composer and choose a saved profile. The task dialog offers two different actions:

- **Use for next request** leaves the current response and tool execution alone. It queues the profile for the next model-request boundary in this task. It does not start a request, create a branch, or change the global profile. The next request can be an automatic continuation after tools, not only your next message. The composer shows **(next request)** until the choice takes effect.
- **Stop and restart with this model** retains its existing replay, workspace-confirmation, and task-graph restrictions. It can remain unavailable even when next-request selection is allowed.

Pending selections exist only in the current task instance. Closing or reloading before the choice takes effect discards it. Prepared replay branches keep their pinned profile. An active mediated Anthropic runtime cannot switch to another provider through this control. Organization policy still applies.

## Anthropic, OpenAI, and DeepSeek compatibility

The additional source-level compatibility fixes cover all six switching directions
between Anthropic, OpenAI Native (Responses API), and DeepSeek for ordinary tasks.
OpenAI Chat Completions and Codex history conversion also have focused coverage.
Select a saved destination profile and use **Use for next request**. The current
response and tools finish under the old profile; the next request uses the new one.

Conversation text and completed tool-call/result pairs remain intact. Incompatible
provider-specific reasoning is excluded from outgoing requests, not deleted from
saved history. OpenAI encrypted reasoning is not sent to Anthropic or Chat
Completions. Native Claude thinking signatures remain intact on Claude requests.
Adaptive Claude can accept a continuation without a prior Claude thinking block.
Manual-thinking Claude uses a request-only non-thinking fallback when the final
assistant turn lacks that required block. DeepSeek uses the fallback described in
the [DeepSeek compatibility guide](deepseek-history-compatibility.md).

These checks verify constructed requests and safe profile application, not live
acceptance by every model or account. Valid credentials, model access, context
capacity, and compatible image/tool capabilities are still required. Pinned replay
branches and the experimental Anthropic-only mediated runtime retain their safety
restrictions. No admission controls are bypassed to enable a switch.

The compatibility fixes start in 4.2.33; they are not in 4.2.31 or 4.2.32.
Claude's manual/adaptive distinction follows its
[extended-thinking documentation](https://platform.claude.com/docs/en/build-with-claude/extended-thinking),
read 2026-10-17, section Turn structure in manual mode.

LiteLLM and OpenAI-compatible proxy connections benefit from the shared message
conversion fixes. However, the direct Anthropic/DeepSeek thinking fallbacks do
not automatically apply to proxy aliases. Claude and DeepSeek thinking-mode
switching through LiteLLM remains incomplete and unverified. No live proxy was
tested, including proxy routes serving actual OpenAI models.

Rejected operations return a result tied to the original action. If no terminal result arrives within 60 seconds, Roo reports an unknown outcome. It does not automatically replay the action. Inspect the task before retrying or reopening it from History.

## Edit your own message

Editing your message discards later conversation messages and resumes from the replacement. It can send a new model request. It does not restore files. Back up important conversations before editing.

1. Stop active work and reopen the task from History without resuming it.
2. Return to the latest page of the foreground task.
3. Select **Edit** on your message.
4. Wait for the complete stored text and attachments to load.
5. Change the text and select **Save and confirm**.
6. Confirm the rewind in the dialog.

The initial task prompt, historical pages, ambiguous stored turns, and prepared replay tasks are not supported. Requests, tools, approvals, terminals, queued messages, and unsettled delegation must finish before an edit can be saved. Checkpoint restoration is not part of message editing; use the separate checkpoint controls when needed.

Both short messages and truncated previews use the same identity-checked editor. The editor keeps existing attachments and does not replace full stored text with a preview. The draft stays open through confirmation, cancellation, reported failure, and acknowledgement timeout. A repeated retrieval response cannot overwrite a draft. A stale draft must be copied before closing or navigating away; drafts are not durable across webview reloads.

Saving locks task dispatch and writes both histories before admitting the replacement. On persistence failure, Roo attempts rollback and blocks further dispatch in that task instance. An incomplete rollback can leave the same interruption marker used by assistant-response editing. Follow the recovery guidance in [Editing assistant responses](assistant-response-editing.md).

These changes do not alter assistant-response editing: that action preserves later messages and does not run a request.
