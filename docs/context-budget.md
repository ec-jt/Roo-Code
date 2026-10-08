# Context usage and compaction

The context percentage is informational. It shows reported context usage against the full advertised model window, not against an input budget after subtracting reserved output.

Roo does not automatically summarize or truncate because a percentage, estimated token count, or reserved-output budget is reached.

## Default: compact on overflow

**Settings > Context management > Compact on context overflow** is enabled by default. An existing disabled automatic-compaction setting is respected.

1. Roo sends the request without proactive compaction.
2. If the provider explicitly rejects it for exceeding the input/context limit before assistant content or tool calls are emitted, Roo attempts one summary of earlier history.
3. Roo preserves the newest input and its tool-call/result exchange, saves the compacted history, and retries the request once.
4. If summarization fails, the retry fails, or the retry returns no response, Roo stops for manual intervention. It does not silently truncate or enter an automatic overflow-retry loop.

Generic HTTP errors, rate limits, network failures, output-token exhaustion, and ambiguous mentions of context do not trigger compaction. Errors after assistant output starts do not trigger automatic context replay. Cancellation and stale task revisions prevent a late summary from being applied.

The percentage and profile-threshold settings from older versions remain readable for compatibility but no longer control compaction. No saved percentages are rewritten. The unreleased 32K safety-margin proposal was replaced by this on-overflow policy.

## Manual compaction

Turn off **Compact on context overflow** for manual-only behavior. A context-limit rejection then stops the request without automatically changing history. Use the existing context-compaction button while the task is idle, or switch to a suitable model before retrying.

Prepared model-operation replay branches remain immutable and do not auto-compact or auto-retry. Ordinary mediated Anthropic requests obtain normal admission for the summary and retry; this feature does not bypass admission or tool approvals.

## Limits

- The model's advertised window must match the active provider's real limit.
- Providers can require input plus requested output to fit. Output limits still apply to requests, but Roo does not subtract them to trigger proactive compaction.
- A provider must expose an explicit context-limit rejection for automatic recovery. Unrecognized or stripped errors stop or follow their ordinary error handling, not heuristic compaction.
- The summarization request can itself exceed the provider's limit. Roo stops instead of silently dropping history.
- A very large latest input or tool result is preserved, so one compaction may not make it fit.
- The displayed count may lag newly added tool results until usage is reported.
- A summary can change model behavior. Export important history before compaction or security testing.

New settings/help text currently uses English. Automated tests cover the bounded recovery flow; no live-provider or Mac memory-pressure test has been performed.
