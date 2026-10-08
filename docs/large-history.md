# Large conversation histories

## Chat windows

Roo retains the complete task and model conversation on disk and in the extension host. The webview receives a bounded projection, not a truncated authoritative history.

- The initial view contains the original task row and up to 100 recent rows.
- Older, Newer, and Return to latest replace the current page. They do not accumulate the whole conversation in the renderer.
- Normal chat projections have a 1 MiB serialized budget. Ordinary message bodies are previewed at 16 KiB. Images and nested metadata also have limits.
- An unanswered live approval is retained intact, even when it exceeds the normal budget. Roo must not ask the user to approve hidden content.
- Historical pages are read-only. Return to latest to approve, edit, send, or operate the task. Draft input is preserved.
- Large message bodies and stored file diffs can be opened in read-only native editor documents, up to 8 MiB per request. At most four document bodies are retained by the content provider.

The budget covers chat messages and their window metadata, not the complete extension state. Other fields, including task-history listings, have separate costs.

## Full-history summaries

The backend calculates tokens, cache usage, costs, current context size, and file-change counts from the complete UI history. An index updates affected contributions as messages are appended or changed. Rewind and history replacement rebuild the index.

The frontend uses these totals instead of rescanning an entire conversation on each streamed update. The file panel receives bounded summaries, not all stored diffs. Its summary is limited to 200 paths and approximately 64 KiB, with omitted entries reported.

Chat delivery uses bounded replacement snapshots, not a general delta protocol. Replaceable partial text updates are coalesced over a 200 ms interval. Complete messages and approvals are sent immediately.

## Atomic persistence and durability

API and UI history writes share one serialized lane per canonical task directory. Writes remain atomic and locked. While a write is active, a newer pending snapshot of the same file can replace an older pending snapshot. The older caller waits for the replacement to become durable.

An explicit barrier cannot be coalesced away or crossed by coalescing. Delegation, exact replay snapshots, rewinds, and strict saves use barriers. Checkpoint creation drains pending history writes. Closing a task fences new writers from that instance and waits for admitted writes and metadata updates. Replacement and delegation stop on durability failure rather than continuing with potentially stale history.

This does not provide a transaction across API history, UI history, task metadata, and Git checkpoints. It does not serialize separate extension-host processes. Whole-history JSON files and stable in-memory snapshot copies still consume backend memory and disk bandwidth.

## Diagnostic trail

The Roo output channel records sampled chat-window failures and slow rendering. Entries contain sequence, row count, total message count, byte count, phase, and elapsed time. They do not contain conversation bodies, file paths, or task identifiers.

- `webview-unacked`: no receive acknowledgement within 10 seconds.
- `render-unacked`: received, but no post-commit render acknowledgement within 10 seconds.
- `render-slow`: render acknowledgement took more than one second.

Outstanding diagnostic samples are capped at 20, and reports are rate-limited to one per 10 seconds. The render acknowledgement follows a React commit and animation-frame callback. It is not proof that every pixel was painted or that the process has enough memory.

For a grey-panel report, capture the Roo output channel and extension-host/webview developer-console errors around the same time. A missing acknowledgement narrows the failure stage but does not prove an out-of-memory crash. The Mac grey-panel report has not been reproduced on the affected machine.

## Verification limits

Focused automated checks cover synthetic 20, 50, and 100 MiB histories, page bounds, stale state, approval preservation, incremental totals, serialized writes, barriers, and task lifecycle failures. These changes have not been packaged, installed, or tested interactively on the affected Mac. No existing conversation data is migrated or deleted.
