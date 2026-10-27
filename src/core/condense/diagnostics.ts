import type { Anthropic } from "@anthropic-ai/sdk"

const safeCodes = new Set([
	"context-limit",
	"context_length_exceeded",
	"context_window_exceeded",
	"input_too_large",
	"max_output_tokens",
	"rate_limit_exceeded",
	"invalid_api_key",
	"invalid_request_error",
])

/** Never include arbitrary provider strings, message content, or response bodies. */
export function summaryFailureDiagnostics(options: {
	failure: "context-limit" | "empty-summary"
	error?: unknown
	storedMessages: number
	effectiveMessages: number
	requestMessages: Anthropic.Messages.MessageParam[]
	systemPrompt: string
	contextWindow?: number
	inputTokens?: number
	outputTokens?: number
}): string {
	let textCharacters = options.systemPrompt.length
	let imageBlocks = 0
	let otherBlocks = 0
	let largestMessageCharacters = 0
	for (const message of options.requestMessages) {
		let characters = 0
		if (typeof message.content === "string") characters = message.content.length
		else {
			for (const block of message.content) {
				if (block.type === "text") characters += block.text.length
				else if (block.type === "image") imageBlocks++
				else otherBlocks++
			}
		}
		textCharacters += characters
		largestMessageCharacters = Math.max(largestMessageCharacters, characters)
	}
	const number = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "unavailable"
	const error = options.error && typeof options.error === "object" ? options.error : {}
	const status = "status" in error ? error.status : undefined
	const code = "code" in error ? error.code : undefined
	return [
		"Compaction request diagnostics (no conversation content):",
		`Failure: ${options.failure}`,
		`HTTP status: ${typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : "unavailable"}`,
		`Error code: ${typeof code === "string" && safeCodes.has(code) ? code : "unavailable or omitted"}`,
		`Stored messages in summary prefix: ${options.storedMessages}`,
		`Effective history messages: ${options.effectiveMessages}`,
		`Summary request messages (including instructions): ${options.requestMessages.length}`,
		`System prompt characters: ${options.systemPrompt.length}`,
		`Total request text characters: ${textCharacters}`,
		`Largest message text characters: ${largestMessageCharacters}`,
		`Image blocks: ${imageBlocks}; other non-text blocks: ${otherBlocks}`,
		`Advertised context window: ${number(options.contextWindow)}`,
		`Provider-reported input tokens: ${number(options.inputTokens)}`,
		`Provider-reported output tokens: ${number(options.outputTokens)}`,
		"Tools attached by summary caller: 0; previous-response suppression requested: yes",
		"Character counts are UTF-16 code units, not tokens or wire bytes. Image payloads and provider-added overhead are not measured.",
		"The advertised window is model metadata, not a confirmed provider limit. Usage may be unavailable for rejected requests.",
		"Raw error text and response bodies are omitted because they may contain private data.",
	].join("\n")
}
