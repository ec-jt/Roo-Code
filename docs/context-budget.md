# Context usage and compaction

The context percentage is informational. It shows reported context usage against the full advertised model window, not against an input budget after subtracting reserved output.

Roo does not automatically summarize or truncate because a percentage, estimated token count, or reserved-output budget is reached.

## Default: compact on overflow

**Settings > Context management > Compact on context overflow** is enabled by default. An existing disabled automatic-compaction setting is respected.

**Allow truncation fallback** is a separate saved control in the same section. It defaults to enabled to preserve existing behavior, but only applies when **Compact on context overflow** is enabled. Turn it off for compaction-only recovery. Turn off **Compact on context overflow** for manual-only operation. The settings page shows the selected policy; save changes to apply them. Changing these settings does not resume a stopped task.

1. Roo sends the request without proactive compaction.
2. If the provider explicitly rejects it for exceeding the input/context limit before assistant content or tool calls are emitted, Roo attempts one summary of earlier history.
3. Roo preserves the newest input and its tool-call/result exchange, saves the compacted history, and retries the request once.
4. If summarization itself exceeds the provider context limit or returns an empty summary, and **Allow truncation fallback** is enabled, Roo may exclude complete older exchanges before that same single retry. It retains the root/current-summary exchange and the newest user turn with its tool-call/result chain. Stored messages are tagged, not deleted. With fallback disabled, that summary failure stops without truncating or retrying.
5. Other summarization failures, a failed retry, or an empty retry stop for manual intervention. There is no extra retry allowance for truncation.

Truncation displays an explicit reason and excluded-message count. After overflow only, token estimates guide how many complete exchanges to exclude, aiming for approximately 75% of the advertised window while allowing for requested output and known system/tool overhead. This is a recovery target, not a proactive trigger. If protected content is too large, tool pairs are ambiguous, or no safe older exchange exists, Roo stops without truncating. The current summary is retained when earlier history has already been condensed; excluded pre-summary history is not resurrected.

Generic HTTP errors, rate limits, network failures, output-token exhaustion, and ambiguous mentions of context do not trigger compaction. Errors after assistant output starts do not trigger automatic context replay. Cancellation and stale task revisions prevent a late summary from being applied.

The percentage and profile-threshold settings from older versions remain readable for compatibility but no longer control compaction. No saved percentages are rewritten. The unreleased 32K safety-margin proposal was replaced by this on-overflow policy.

## Manual compaction

Compaction makes one standalone summary request using the effective history. It converts tool calls/results to text, omits the normal tool-definition catalog, and suppresses previous-response chaining. The next chat request still uses its normal tools. Roo does not split the conversation into separately summarized sections or summarize intermediate summaries, because that would compound information loss.

If the summary request itself exceeds the provider limit, manual compaction leaves history unchanged and reports that no summary was applied. A summary still needs its input plus reserved output to fit: use a larger-context model or reduce the configured output budget before trying again. Removing tool overhead can help near the limit, but cannot make arbitrarily large history fit. Automatic overflow recovery retains the separate truncation-fallback policy described above; turn **Allow truncation fallback** off to prohibit that exclusion of unsummarized older exchanges.

Context-limit errors distinguish disabled automatic recovery from a request that still overflowed after its single recovery retry. If the retry fails, Roo does not start another compaction/truncation cycle automatically.

Turn off **Compact on context overflow** for manual-only behavior. A context-limit rejection then stops the request without automatically changing history. Use the existing context-compaction button while the task is idle, or switch to a suitable model before retrying.

Prepared model-operation replay branches remain immutable and do not auto-compact or auto-retry. Ordinary mediated Anthropic requests obtain normal admission for the summary and retry; this feature does not bypass admission or tool approvals.

## Limits

- The model's advertised window must match the active provider's real limit.
- Providers can require input plus requested output to fit. Output limits still apply to requests, but Roo does not subtract them to trigger proactive compaction.
- A provider must expose an explicit context-limit rejection for automatic recovery. Unrecognized or stripped errors stop or follow their ordinary error handling, not heuristic compaction.
- Only a recognized compaction context-limit error or an empty summary permits the truncation fallback. Cancellation, stale identity, admission/permission denial, persistence errors, authentication errors, network failures, and rate limits do not authorize truncation.
- A very large latest input or tool result is preserved, so one compaction may not make it fit.
- The displayed count may lag newly added tool results until usage is reported.
- A summary can change model behavior; truncation omits unsummarized context. Export important history before compaction or security testing.

New settings/help text currently uses English. Automated tests cover the bounded recovery flow; no live-provider or Mac memory-pressure test has been performed.
