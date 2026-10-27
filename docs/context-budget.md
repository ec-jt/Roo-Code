# Context usage and compaction

The context percentage is informational. It shows reported context usage against the full advertised model window, not against an input budget after subtracting reserved output.

Roo does not automatically summarize or truncate because a percentage, estimated token count, or reserved-output budget is reached.

## Default: compact on overflow

**Settings > Context management > Compact on context overflow** is enabled by default. An existing disabled automatic-compaction setting is respected.

**Allow truncation fallback** is a separate saved control in the same section. It defaults to enabled to preserve existing behavior, but only applies when **Compact on context overflow** is enabled. Turn it off for compaction-only recovery. Turn off **Compact on context overflow** for manual-only operation. The settings page shows the selected policy; save changes to apply them. Changing these settings does not resume a stopped task.

1. Roo sends the request without proactive compaction.
2. If the provider explicitly rejects it for exceeding the input/context limit before assistant content or tool calls are emitted, Roo attempts one summary of earlier history.
3. Roo preserves the newest input and its tool-call/result exchange, saves the compacted history, and retries the request once.
4. If summarization itself exceeds the provider context limit or returns an empty summary, and **Allow truncation fallback** is enabled, Roo may exclude complete older exchanges before that same single retry. It first retains the root/current-summary exchange and the newest user turn with its tool-call/result chain. If no older exchange is available, or excluding those exchanges still cannot fit, Roo may exclude older completed tool-call/result groups within the retained turns. It preserves the root/current summary, user input and feedback in those turns, and the newest complete tool interaction. Stored messages are tagged, not deleted. With fallback disabled, that summary failure stops without truncating or retrying.
5. Other summarization failures, a failed retry, or an empty retry stop for manual intervention. There is no extra retry allowance for truncation.

Truncation displays an explicit reason and excluded-message count. After overflow only, token estimates guide how many complete exchanges to exclude, aiming for approximately 75% of the advertised window while allowing for requested output and known system/tool overhead. This is a recovery target, not a proactive trigger. If protected content is too large, tool pairs are ambiguous, or no safe older exchange exists, Roo stops without truncating. The current summary is retained when earlier history has already been condensed; excluded pre-summary history is not resurrected.

Tool-group fallback keeps parallel tool calls and all their results together. It preserves groups containing follow-up questions, completion feedback, delegation, mode switching, user-feedback tags, non-environment user text, or non-text result blocks. It does not infer that a user instruction is expendable because it arrived through a tool result. Feedback-looking text quoted in ordinary output can conservatively protect that group too. This fallback omits unsummarized information; it is not lossless compaction. A marker explicitly tells the model that excluded content is no longer visible and that original history remains stored. No additional summary request is made.

**No earlier complete exchange can be excluded safely** means the fallback made no history changes and found neither a removable older exchange nor an eligible older tool group. Repeating truncation on the same history cannot resolve this. Use a larger-context model for compaction, or start a new task with a handoff you have reviewed. The error also retains the original compaction failure so it is clear why fallback was attempted. If the protected input, feedback, or newest tool result still cannot fit after all eligible exclusions, Roo leaves history unchanged rather than applying an insufficient partial truncation.

Generic HTTP errors, rate limits, network failures, output-token exhaustion, and ambiguous mentions of context do not trigger compaction. Errors after assistant output starts do not trigger automatic context replay. Cancellation and stale task revisions prevent a late summary from being applied.

The percentage and profile-threshold settings from older versions remain readable for compatibility but no longer control compaction. No saved percentages are rewritten. The unreleased 32K safety-margin proposal was replaced by this on-overflow policy.

## Manual compaction

Compaction makes one standalone summary request using the effective history. It converts tool calls/results to text, omits the normal tool-definition catalog, and suppresses previous-response chaining. The next chat request still uses its normal tools. Roo does not split the conversation into separately summarized sections or summarize intermediate summaries, because that would compound information loss.

If the summary request itself exceeds the provider limit, manual compaction leaves history unchanged and reports that no summary was applied. A summary still needs its input plus reserved output to fit: use a larger-context model or reduce the configured output budget before trying again. Removing tool overhead can help near the limit, but cannot make arbitrarily large history fit. Automatic overflow recovery retains the separate truncation-fallback policy described above; turn **Allow truncation fallback** off to prohibit that exclusion of unsummarized older exchanges.

Context-limit errors distinguish disabled automatic recovery from a request that still overflowed after its single recovery retry. If the retry fails, Roo does not start another compaction/truncation cycle automatically.

Summary context-limit and empty-summary failures include content-free request diagnostics: stored-prefix and effective-message counts, text character counts after tool conversion, image/non-text block counts, advertised context window, available provider-reported usage, HTTP status, and allowlisted error codes. Arbitrary provider error strings and bodies are not copied into these diagnostics. Character counts are not token counts or exact wire sizes; provider-added overhead is not measured, and rejected requests often have no usage. These diagnostics do not add a token-counting API request or change recovery eligibility. Generic provider errors retain their existing diagnostic handling. The full history export can still contain private conversation data and must be reviewed before sharing.

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
