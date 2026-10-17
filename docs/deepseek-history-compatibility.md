# Switching existing tasks to DeepSeek

DeepSeek thinking requests with tools require plaintext reasoning for every
historical assistant turn, including turns without tool calls. GPT encrypted
reasoning cannot be converted into DeepSeek reasoning. Legacy histories and
tool-only assistant turns can also lack the required data.

Roo checks history before building a DeepSeek thinking request. When tools or
historical tool calls are present and any assistant turn lacks usable plaintext
reasoning, Roo explicitly disables thinking for that request. It keeps the
selected model, conversation text, tool-call IDs, arguments, and results. It
does not fabricate reasoning, modify saved history, discard turns, or replay
tools. An extension-host warning records that compatibility mode was used.

Thinking stays enabled when all assistant turns have usable reasoning, or when
there is no tool context. Multiple plaintext reasoning blocks and merged
assistant turns retain their reasoning instead of keeping only the last block.

Compatibility mode is evaluated for each request, not just once after a model
switch. It can remain active while incompatible turns remain in effective
history. A new DeepSeek task avoids that inherited-history limitation. Do not
delete valuable history merely to enable thinking.

This addresses the request-format error, not the underlying work performed by
the task. Before resuming after an API error, inspect existing background work;
an API rejection does not prove earlier commands stopped.

Source: [DeepSeek thinking-mode documentation](https://api-docs.deepseek.com/guides/thinking_mode),
read 2026-10-17, especially Input and Output Parameters and Tool Calls. The
compatibility behavior is covered by mocked request-payload tests; live API
acceptance is not verified. Custom endpoints that do not support the thinking
toggle may behave differently. This direct-provider fix starts in 4.2.33;
releases 4.2.31 and 4.2.32 do not contain it. It does not automatically apply to
DeepSeek aliases through the LiteLLM or generic OpenAI-compatible providers.
