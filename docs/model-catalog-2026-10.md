# October 2026 model catalog update

## OpenAI ChatGPT Plus/Pro

Added GPT-6.1 Sol using model ID `gpt-6.1-sol`. It has a 1,050,000-token context window, 128,000-token output limit, image input, and reasoning effort levels low, medium, high, xhigh, and max. Medium is the default; none and minimal are unsupported. Stale unsupported effort settings fall back to medium. Tool use stays on the provider's Responses transport.

The ChatGPT subscription catalog uses zero per-token cost estimates, not public API pricing. Adding the model does not grant account access: subscription entitlements and backend availability still apply. Existing selected models and the provider default are unchanged. The direct OpenAI API provider is outside this update's scope.

Source: [OpenAI GPT-6.1 Sol model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol), checked October 6, 2026.

## Anthropic

Added Claude Opus 5.5 using model ID `claude-opus-5-5`. It has native 1M context, 128K output, image input, always-on adaptive thinking, and medium effort by default. Standard per-million-token prices are $4 input, $20 output, $5 for five-minute cache writes, and $0.20 for cache reads.

Claude Fable 5.1 was already present. Its high default effort and existing catalog prices are retained. The official model pages still list Fable 5.1; no Fable 5.2 ID was added without an official listing.

Both models keep adaptive thinking enabled despite stale disable settings and omit unsupported forced tool choices. Summarized thinking is requested for progress visibility. The documented thinking-binding compatibility beta allows the API to drop prior thinking blocks whose prefix no longer matches after Roo edits prompts/tools or condenses history. This avoids a request rejection but can reduce continuity of affected prior reasoning. Roo does not alter replayed thinking blocks or signatures locally.

Sources:
- [Opus 5.5 overview](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Opus 5.5 breaking changes and migration requirements](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5)

## Verification limits

Focused tests cover catalog metadata and generated request settings. No live paid inference or account-entitlement verification was performed. Anthropic changes apply to its direct provider, not Bedrock, Vertex, or router catalogs. Model defaults were not changed.
