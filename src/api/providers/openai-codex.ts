import * as os from "os"
import { v7 as uuidv7 } from "uuid"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	openAiCodexDefaultModelId,
	OpenAiCodexModelId,
	openAiCodexModels,
	type ReasoningEffort,
	type ReasoningEffortExtended,
} from "@roo-code/types"

import { Package } from "../../shared/package"
import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import { isMcpTool } from "../../utils/mcp-name"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"
import { openAiCodexOAuthManager } from "../../integrations/openai-codex/oauth"
import { t } from "../../i18n"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { configureApiRequestTimeout } from "./utils/sdk-timeout"

export type OpenAiCodexModel = ReturnType<OpenAiCodexHandler["getModel"]>

// Only local SDK capability checks may trigger a new request through the SSE fallback.
class CodexSdkCompatibilityError extends Error {}

// A terminal event belongs to an accepted generation, not a rejected auth request.
// Keep this identity through the manual SSE wrappers so it can never trigger replay.
class CodexTerminalResponseError extends Error {
	constructor(status: "failed" | "incomplete", detail: unknown) {
		// Provider messages and arbitrary codes can contain credentials or request data.
		// Report only known protocol codes/reasons, never the raw response payload.
		const safeDetails = new Set([
			"server_error",
			"rate_limit_exceeded",
			"invalid_prompt",
			"vector_store_timeout",
			"invalid_image",
			"invalid_image_format",
			"invalid_base64_image",
			"invalid_image_url",
			"image_too_large",
			"image_too_small",
			"image_parse_error",
			"image_content_policy_violation",
			"invalid_image_mode",
			"image_file_too_large",
			"unsupported_image_media_type",
			"empty_image_file",
			"failed_to_download_image",
			"image_file_not_found",
			"max_output_tokens",
			"content_filter",
			"authentication_error",
		])
		const reason = typeof detail === "string" && safeDetails.has(detail) ? ` (${detail})` : ""
		super(`OpenAI Codex response ${status}${reason}.`)
	}
}

interface CodexToolCallState {
	callId?: string
	itemId?: string
	outputIndex?: number
	name?: string
	streamIndex: number
	completeArguments?: string
	completed: boolean
}

/**
 * OpenAI Codex base URL for API requests
 * Per the implementation guide: requests are routed to chatgpt.com/backend-api/codex
 */
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiNativeHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 */
export class OpenAiCodexHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private readonly providerName = "OpenAI Codex"
	private client?: OpenAI
	// Complete response output array
	private lastResponseOutput: any[] | undefined
	// Last top-level response id
	private lastResponseId: string | undefined
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string
	// Responses argument events may identify a call by call ID, item ID, or output index.
	private toolCalls = new Set<CodexToolCallState>()
	private toolCallsByCallId = new Map<string, CodexToolCallState>()
	private toolCallsByItemId = new Map<string, CodexToolCallState>()
	private toolCallsByOutputIndex = new Map<number, CodexToolCallState>()
	// Tracks whether this response already emitted text to avoid duplicate done-event rendering.
	private sawTextOutputInCurrentResponse = false
	// Tracks whether text arrived through delta events so content_part events can be treated as fallback-only.
	private sawTextDeltaInCurrentResponse = false

	// Event types handled by the shared event processor
	private readonly coreHandledEventTypes = new Set<string>([
		"response.text.delta",
		"response.output_text.delta",
		"response.text.done",
		"response.output_text.done",
		"response.content_part.added",
		"response.content_part.done",
		"response.reasoning.delta",
		"response.reasoning_text.delta",
		"response.reasoning_summary.delta",
		"response.reasoning_summary_text.delta",
		"response.refusal.delta",
		"response.output_item.added",
		"response.output_item.done",
		"response.done",
		"response.completed",
		"response.failed",
		"response.incomplete",
		"response.tool_call_arguments.delta",
		"response.function_call_arguments.delta",
		"response.tool_call_arguments.done",
		"response.function_call_arguments.done",
	])

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		// Generate a new session ID for standalone handler usage (fallback)
		this.sessionId = uuidv7()
	}

	private normalizeUsage(usage: any, model: OpenAiCodexModel): ApiStreamUsageChunk | undefined {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details

		const hasCachedTokens = typeof inputDetails?.cached_tokens === "number"
		const hasCacheMissTokens = typeof inputDetails?.cache_miss_tokens === "number"
		const cachedFromDetails = hasCachedTokens ? inputDetails.cached_tokens : 0
		const missFromDetails = hasCacheMissTokens ? inputDetails.cache_miss_tokens : 0

		let totalInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		if (totalInputTokens === 0 && inputDetails && (cachedFromDetails > 0 || missFromDetails > 0)) {
			totalInputTokens = cachedFromDetails + missFromDetails
		}

		const totalOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0
		const cacheReadTokens =
			usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cached_tokens ?? cachedFromDetails ?? 0

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		// Subscription-based: no per-token costs
		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: 0, // Subscription-based pricing
		}
		return out
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const model = this.getModel()
		yield* this.handleResponsesApiMessage(model, systemPrompt, messages, metadata)
	}

	private async *handleResponsesApiMessage(
		model: OpenAiCodexModel,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Reset state for this request
		this.lastResponseOutput = undefined
		this.lastResponseId = undefined
		this.toolCalls.clear()
		this.toolCallsByCallId.clear()
		this.toolCallsByItemId.clear()
		this.toolCallsByOutputIndex.clear()
		this.sawTextOutputInCurrentResponse = false
		this.sawTextDeltaInCurrentResponse = false

		// Get access token from OAuth manager
		let accessToken = await openAiCodexOAuthManager.getAccessToken()
		if (!accessToken) {
			throw new Error(
				t("common:errors.openAiCodex.notAuthenticated", {
					defaultValue:
						"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
				}),
			)
		}

		// Resolve reasoning effort
		const reasoningEffort = this.getReasoningEffort(model)

		// Format conversation
		const formattedInput = this.formatFullConversation(systemPrompt, messages)

		// Build request body
		// Per the implementation guide: Codex backend may reject some parameters
		// Notably: max_output_tokens and prompt_cache_retention may be rejected
		const requestBody = this.buildRequestBody(model, formattedInput, systemPrompt, reasoningEffort, metadata)

		// Make the request with retry on auth failure
		let hasEmittedOutput = false
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				for await (const chunk of this.executeRequest(requestBody, model, accessToken, metadata?.taskId)) {
					hasEmittedOutput = true
					yield chunk
				}
				return
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const isAuthFailure = /unauthorized|invalid token|not authenticated|authentication|401/i.test(message)

				if (
					attempt === 0 &&
					isAuthFailure &&
					!hasEmittedOutput &&
					!(error instanceof CodexTerminalResponseError)
				) {
					// Force refresh the token for retry
					const refreshed = await openAiCodexOAuthManager.forceRefreshAccessToken()
					if (!refreshed) {
						throw new Error(
							t("common:errors.openAiCodex.notAuthenticated", {
								defaultValue:
									"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
							}),
						)
					}
					accessToken = refreshed
					continue
				}
				throw error
			}
		}
	}

	private buildRequestBody(
		model: OpenAiCodexModel,
		formattedInput: any,
		systemPrompt: string,
		reasoningEffort: ReasoningEffortExtended | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): any {
		const ensureAllRequired = (schema: any): any => {
			if (!schema || typeof schema !== "object" || schema.type !== "object") {
				return schema
			}

			const result = { ...schema }
			if (result.additionalProperties !== false) {
				result.additionalProperties = false
			}

			if (result.properties) {
				const allKeys = Object.keys(result.properties)
				result.required = allKeys

				const newProps = { ...result.properties }
				for (const key of allKeys) {
					const prop = newProps[key]
					if (prop.type === "object") {
						newProps[key] = ensureAllRequired(prop)
					} else if (prop.type === "array" && prop.items?.type === "object") {
						newProps[key] = {
							...prop,
							items: ensureAllRequired(prop.items),
						}
					}
				}
				result.properties = newProps
			}

			return result
		}

		const ensureAdditionalPropertiesFalse = (schema: any): any => {
			if (!schema || typeof schema !== "object" || schema.type !== "object") {
				return schema
			}

			const result = { ...schema }
			if (result.additionalProperties !== false) {
				result.additionalProperties = false
			}

			if (result.properties) {
				const newProps = { ...result.properties }
				for (const key of Object.keys(result.properties)) {
					const prop = newProps[key]
					if (prop && prop.type === "object") {
						newProps[key] = ensureAdditionalPropertiesFalse(prop)
					} else if (prop && prop.type === "array" && prop.items?.type === "object") {
						newProps[key] = {
							...prop,
							items: ensureAdditionalPropertiesFalse(prop.items),
						}
					}
				}
				result.properties = newProps
			}

			return result
		}

		interface ResponsesRequestBody {
			model: string
			input: Array<{ role: "user" | "assistant"; content: any[] } | { type: string; content: string }>
			stream: boolean
			reasoning?: { effort?: ReasoningEffortExtended; summary?: "auto" }
			temperature?: number
			store?: boolean
			instructions?: string
			include?: string[]
			tools?: Array<{
				type: "function"
				name: string
				description?: string
				parameters?: any
				strict?: boolean
			}>
			tool_choice?: any
			parallel_tool_calls?: boolean
		}

		// Per the implementation guide: Codex backend may reject max_output_tokens
		// and prompt_cache_retention, so we omit them
		const body: ResponsesRequestBody = {
			model: model.id,
			input: formattedInput,
			stream: true,
			store: false,
			instructions: systemPrompt,
			// Only include encrypted reasoning content when reasoning effort is set
			...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			...(reasoningEffort
				? {
						reasoning: {
							...(reasoningEffort ? { effort: reasoningEffort } : {}),
							summary: "auto" as const,
						},
					}
				: {}),
			tools: (metadata?.tools ?? [])
				.filter((tool) => tool.type === "function")
				.map((tool) => {
					const isMcp = isMcpTool(tool.function.name)
					return {
						type: "function",
						name: tool.function.name,
						description: tool.function.description,
						parameters: isMcp
							? ensureAdditionalPropertiesFalse(tool.function.parameters)
							: ensureAllRequired(tool.function.parameters),
						strict: !isMcp,
					}
				}),
			tool_choice: metadata?.tool_choice,
			parallel_tool_calls: metadata?.parallelToolCalls ?? true,
		}

		return body
	}

	private async *executeRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		accessToken: string,
		taskId?: string,
	): ApiStream {
		// Create AbortController for cancellation
		this.abortController = new AbortController()
		let hasEmittedOutput = false

		try {
			// Prefer OpenAI SDK streaming (same approach as openai-native) so event handling
			// is consistent across providers.
			try {
				// Get ChatGPT account ID for organization subscriptions
				const accountId = await openAiCodexOAuthManager.getAccountId()

				// Build Codex-specific headers. Authorization is provided by the SDK apiKey.
				const codexHeaders: Record<string, string> = {
					originator: "roo-code",
					session_id: taskId || this.sessionId,
					// Codex backend parity with the reference implementations: opt into the
					// experimental Responses surface and mirror session_id for upstream correlation.
					"OpenAI-Beta": "responses=experimental",
					"x-client-request-id": taskId || this.sessionId,
					"User-Agent": `roo-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
					...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
				}

				// Allow tests to inject a client. If none is injected, create one for this request.
				const client =
					this.client ??
					configureApiRequestTimeout(
						new OpenAI({
							timeout: getApiRequestTimeout(),
							apiKey: accessToken,
							baseURL: CODEX_API_BASE_URL,
							defaultHeaders: codexHeaders,
						}),
					)

				if (typeof client.responses?.create !== "function") {
					throw new CodexSdkCompatibilityError("OpenAI SDK does not support Responses API streaming.")
				}

				const stream = (await (client as any).responses.create(requestBody, {
					signal: this.abortController.signal,
					// If the SDK supports per-request overrides, ensure headers are present.
					headers: codexHeaders,
				})) as AsyncIterable<any>

				if (typeof (stream as any)?.[Symbol.asyncIterator] !== "function") {
					throw new CodexSdkCompatibilityError(
						"OpenAI SDK did not return an AsyncIterable for Responses API streaming. Falling back to SSE.",
					)
				}

				for await (const event of stream) {
					if (this.abortController.signal.aborted) {
						break
					}

					for await (const outChunk of this.processEvent(event, model)) {
						hasEmittedOutput = true
						if (outChunk.type === "text") {
							this.sawTextOutputInCurrentResponse = true
						}
						yield outChunk
					}
				}
			} catch (sdkErr) {
				// Never replay failed requests or combine output from separate generations.
				if (
					!(sdkErr instanceof CodexSdkCompatibilityError) ||
					hasEmittedOutput ||
					this.abortController.signal.aborted
				) {
					throw sdkErr
				}
				// Fallback only when the SDK lacks the required streaming interface.
				yield* this.makeCodexRequest(requestBody, model, accessToken, taskId)
			}
		} finally {
			this.abortController = undefined
		}
	}

	private formatFullConversation(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): any {
		const formattedInput: any[] = []

		for (const message of messages) {
			// Check if this is a reasoning item
			if ((message as any).type === "reasoning") {
				formattedInput.push(message)
				continue
			}

			if (message.role === "user") {
				const content: any[] = []
				const toolResults: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "input_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "input_text", text: block.text })
						} else if (block.type === "image") {
							const image = block as Anthropic.Messages.ImageBlockParam
							const imageUrl = `data:${image.source.media_type};base64,${image.source.data}`
							content.push({ type: "input_image", image_url: imageUrl })
						} else if (block.type === "tool_result") {
							const result =
								typeof block.content === "string"
									? block.content
									: block.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || ""
							toolResults.push({
								type: "function_call_output",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.tool_use_id),
								output: result,
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "user", content })
				}

				if (toolResults.length > 0) {
					formattedInput.push(...toolResults)
				}
			} else if (message.role === "assistant") {
				const content: any[] = []
				const toolCalls: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "output_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "output_text", text: block.text })
						} else if (block.type === "tool_use") {
							toolCalls.push({
								type: "function_call",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.id),
								name: block.name,
								arguments: JSON.stringify(block.input),
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "assistant", content })
				}

				if (toolCalls.length > 0) {
					formattedInput.push(...toolCalls)
				}
			}
		}

		return formattedInput
	}

	private async *makeCodexRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		accessToken: string,
		taskId?: string,
	): ApiStream {
		// Per the implementation guide: route to Codex backend with Bearer token
		const url = `${CODEX_API_BASE_URL}/responses`

		// Get ChatGPT account ID for organization subscriptions
		const accountId = await openAiCodexOAuthManager.getAccountId()

		// Build headers with required Codex-specific fields
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			originator: "roo-code",
			session_id: taskId || this.sessionId,
			// Codex backend parity: beta flag plus a client request id matching session_id.
			"OpenAI-Beta": "responses=experimental",
			"x-client-request-id": taskId || this.sessionId,
			"User-Agent": `roo-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
		}

		// Add ChatGPT-Account-Id if available (required for organization subscriptions)
		if (accountId) {
			headers["ChatGPT-Account-Id"] = accountId
		}

		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController?.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()

				let errorMessage = t("common:errors.api.apiRequestFailed", { status: response.status })
				let errorDetails = ""

				try {
					const errorJson = JSON.parse(errorText)
					if (errorJson.error?.message) {
						errorDetails = errorJson.error.message
					} else if (errorJson.message) {
						errorDetails = errorJson.message
					} else if (errorJson.detail) {
						errorDetails = errorJson.detail
					} else {
						errorDetails = errorText
					}
				} catch {
					errorDetails = errorText
				}

				switch (response.status) {
					case 400:
						errorMessage = t("common:errors.openAiCodex.invalidRequest")
						break
					case 401:
						errorMessage = t("common:errors.openAiCodex.authenticationFailed")
						break
					case 403:
						errorMessage = t("common:errors.openAiCodex.accessDenied")
						break
					case 404:
						errorMessage = t("common:errors.openAiCodex.endpointNotFound")
						break
					case 429:
						errorMessage = t("common:errors.openAiCodex.rateLimitExceeded")
						break
					case 500:
					case 502:
					case 503:
						errorMessage = t("common:errors.openAiCodex.serviceError")
						break
					default:
						errorMessage = t("common:errors.openAiCodex.genericError", { status: response.status })
				}

				if (errorDetails) {
					errorMessage += ` - ${errorDetails}`
				}

				throw new Error(errorMessage)
			}

			if (!response.body) {
				throw new Error(t("common:errors.openAiCodex.noResponseBody"))
			}

			yield* this.handleStreamResponse(response.body, model)
		} catch (error) {
			if (error instanceof CodexTerminalResponseError) throw error
			const errorMessage = error instanceof Error ? error.message : String(error)

			if (error instanceof Error) {
				if (error.message.includes("Codex API")) {
					throw error
				}
				throw new Error(t("common:errors.openAiCodex.connectionFailed", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedConnectionError"))
		}
	}

	private async *handleStreamResponse(body: ReadableStream<Uint8Array>, model: OpenAiCodexModel): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		let hasContent = false

		try {
			while (true) {
				if (this.abortController?.signal.aborted) {
					break
				}

				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim()
						if (data === "[DONE]") {
							continue
						}

						let parsed
						try {
							parsed = JSON.parse(data)
						} catch {
							// Ignore malformed JSON, not errors from processing valid events.
							continue
						}

						// Capture response metadata
						if (parsed.response?.output && Array.isArray(parsed.response.output)) {
							this.lastResponseOutput = parsed.response.output
						}
						if (parsed.response?.id) {
							this.lastResponseId = parsed.response.id as string
						}

						// Delegate standard event types
						if (parsed?.type && this.coreHandledEventTypes.has(parsed.type)) {
							// Some Codex streams only return tool calls (no text). Treat tool output as content.
							if (
								parsed.type === "response.function_call_arguments.delta" ||
								parsed.type === "response.tool_call_arguments.delta" ||
								parsed.type === "response.output_item.added" ||
								parsed.type === "response.output_item.done"
							) {
								hasContent = true
							}

							for await (const outChunk of this.processEvent(parsed, model)) {
								if (outChunk.type === "text" || outChunk.type === "reasoning") {
									hasContent = true
									if (outChunk.type === "text") {
										this.sawTextOutputInCurrentResponse = true
									}
								}
								yield outChunk
							}
							continue
						}

						// Handle complete response
						if (parsed.response && parsed.response.output && Array.isArray(parsed.response.output)) {
							for (const outputItem of parsed.response.output) {
								if (outputItem.type === "text" && outputItem.content) {
									for (const content of outputItem.content) {
										if (content.type === "text" && content.text) {
											hasContent = true
											this.sawTextOutputInCurrentResponse = true
											yield { type: "text", text: content.text }
										}
									}
								}
								if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
									for (const summary of outputItem.summary) {
										if (summary?.type === "summary_text" && typeof summary.text === "string") {
											hasContent = true
											yield { type: "reasoning", text: summary.text }
										}
									}
								}
							}
							if (parsed.response.usage) {
								const usageData = this.normalizeUsage(parsed.response.usage, model)
								if (usageData) {
									yield usageData
								}
							}
						} else if (
							parsed.type === "response.text.delta" ||
							parsed.type === "response.output_text.delta"
						) {
							if (parsed.delta) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.delta }
							}
						} else if (
							(parsed.type === "response.text.done" || parsed.type === "response.output_text.done") &&
							!hasContent
						) {
							const doneText =
								typeof parsed.text === "string"
									? parsed.text
									: typeof parsed.output_text === "string"
										? parsed.output_text
										: typeof parsed.delta === "string"
											? parsed.delta
											: undefined
							if (doneText) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: doneText }
							}
						} else if (
							parsed.type === "response.reasoning.delta" ||
							parsed.type === "response.reasoning_text.delta"
						) {
							if (parsed.delta) {
								hasContent = true
								yield { type: "reasoning", text: parsed.delta }
							}
						} else if (
							parsed.type === "response.reasoning_summary.delta" ||
							parsed.type === "response.reasoning_summary_text.delta"
						) {
							if (parsed.delta) {
								hasContent = true
								yield { type: "reasoning", text: parsed.delta }
							}
						} else if (parsed.type === "response.refusal.delta") {
							if (parsed.delta) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: `[Refusal] ${parsed.delta}` }
							}
						} else if (parsed.type === "response.output_item.added") {
							if (parsed.item) {
								if (parsed.item.type === "text" && parsed.item.text) {
									hasContent = true
									this.sawTextOutputInCurrentResponse = true
									yield { type: "text", text: parsed.item.text }
								} else if (parsed.item.type === "reasoning" && parsed.item.text) {
									hasContent = true
									yield { type: "reasoning", text: parsed.item.text }
								} else if (parsed.item.type === "message" && parsed.item.content) {
									for (const content of parsed.item.content) {
										if (content.type === "text" && content.text) {
											hasContent = true
											this.sawTextOutputInCurrentResponse = true
											yield { type: "text", text: content.text }
										}
									}
								}
							}
						} else if (parsed.type === "response.error" || parsed.type === "error") {
							if (parsed.error || parsed.message) {
								throw new Error(
									t("common:errors.openAiCodex.apiError", {
										message: parsed.error?.message || parsed.message || "Unknown error",
									}),
								)
							}
						} else if (parsed.type === "response.completed" || parsed.type === "response.done") {
							if (parsed.response?.output && Array.isArray(parsed.response.output)) {
								this.lastResponseOutput = parsed.response.output
							}
							if (parsed.response?.id) {
								this.lastResponseId = parsed.response.id as string
							}

							if (
								!hasContent &&
								parsed.response &&
								parsed.response.output &&
								Array.isArray(parsed.response.output)
							) {
								for (const outputItem of parsed.response.output) {
									if (outputItem.type === "message" && outputItem.content) {
										for (const content of outputItem.content) {
											if (content.type === "output_text" && content.text) {
												hasContent = true
												this.sawTextOutputInCurrentResponse = true
												yield { type: "text", text: content.text }
											}
										}
									}
									if (outputItem.type === "reasoning" && Array.isArray(outputItem.summary)) {
										for (const summary of outputItem.summary) {
											if (summary?.type === "summary_text" && typeof summary.text === "string") {
												hasContent = true
												yield { type: "reasoning", text: summary.text }
											}
										}
									}
								}
							}
						} else if (parsed.choices?.[0]?.delta?.content) {
							hasContent = true
							this.sawTextOutputInCurrentResponse = true
							yield { type: "text", text: parsed.choices[0].delta.content }
						} else if (parsed.item && typeof parsed.item.text === "string" && parsed.item.text.length > 0) {
							hasContent = true
							this.sawTextOutputInCurrentResponse = true
							yield { type: "text", text: parsed.item.text }
						} else if (parsed.usage) {
							const usageData = this.normalizeUsage(parsed.usage, model)
							if (usageData) {
								yield usageData
							}
						}
					} else if (line.trim() && !line.startsWith(":")) {
						try {
							const parsed = JSON.parse(line)
							if (parsed.content || parsed.text || parsed.message) {
								hasContent = true
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: parsed.content || parsed.text || parsed.message }
							}
						} catch {
							// Not JSON, ignore
						}
					}
				}
			}
		} catch (error) {
			if (error instanceof CodexTerminalResponseError) throw error
			const errorMessage = error instanceof Error ? error.message : String(error)

			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.streamProcessingError", { message: error.message }))
			}
			throw new Error(t("common:errors.openAiCodex.unexpectedStreamError"))
		} finally {
			reader.releaseLock()
		}
	}

	private resolveToolCall(event: any, item?: any): CodexToolCallState | undefined {
		const nonemptyString = (value: unknown): string | undefined =>
			typeof value === "string" && value.length > 0 ? value : undefined
		const callId = nonemptyString(
			item ? item.call_id || item.tool_call_id : event.call_id || event.tool_call_id || event.id,
		)
		const itemId = nonemptyString(item?.id || event.item_id)
		const name = nonemptyString(
			item ? item.name || item.function?.name || item.function_name : event.name || event.function_name,
		)
		const rawIndex = event.output_index ?? event.index
		const outputIndex =
			typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : undefined
		const matches = new Set(
			[
				callId ? this.toolCallsByCallId.get(callId) : undefined,
				itemId ? this.toolCallsByItemId.get(itemId) : undefined,
				outputIndex !== undefined ? this.toolCallsByOutputIndex.get(outputIndex) : undefined,
			].filter((call): call is CodexToolCallState => call !== undefined),
		)
		// Conflicting identities must never join arguments from different calls.
		if (matches.size > 1) return undefined
		let call = matches.values().next().value as CodexToolCallState | undefined
		if (!call && !callId && !itemId && outputIndex === undefined) {
			if (this.toolCalls.size !== 1) return undefined
			call = this.toolCalls.values().next().value
		}
		if (call) {
			if (
				(callId && call.callId && callId !== call.callId) ||
				(itemId && call.itemId && itemId !== call.itemId) ||
				(outputIndex !== undefined && call.outputIndex !== undefined && outputIndex !== call.outputIndex) ||
				(name && call.name && name !== call.name)
			) {
				return undefined
			}
		} else {
			// Keep the parser index stable and unique, including calls without an output index.
			const usedIndices = new Set([...this.toolCalls].map((candidate) => candidate.streamIndex))
			let streamIndex = outputIndex ?? 0
			while (usedIndices.has(streamIndex)) streamIndex++
			call = { streamIndex, completed: false }
			this.toolCalls.add(call)
		}
		if (callId) {
			call.callId = callId
			this.toolCallsByCallId.set(callId, call)
		}
		if (itemId) {
			call.itemId = itemId
			this.toolCallsByItemId.set(itemId, call)
		}
		if (outputIndex !== undefined) {
			call.outputIndex = outputIndex
			this.toolCallsByOutputIndex.set(outputIndex, call)
		}
		if (name) call.name = name
		return call
	}

	private async *completeToolCall(call: CodexToolCallState | undefined, args?: unknown): ApiStream {
		if (!call || call.completed) return
		if (typeof args === "string" && args.length > 0) {
			call.completeArguments = args
		} else if (args && typeof args === "object") {
			call.completeArguments = JSON.stringify(args)
		}
		if (!call.callId || !call.name || call.completeArguments === undefined) return
		call.completed = true
		// This payload replaces streamed bytes. The consumer upserts the same call ID.
		yield { type: "tool_call", id: call.callId, name: call.name, arguments: call.completeArguments }
	}

	private async *processEvent(event: any, model: OpenAiCodexModel): ApiStream {
		// Check terminal failures before treating response.output as successful output.
		if (event?.type === "response.failed" || event?.type === "response.incomplete") {
			const incomplete = event.type === "response.incomplete"
			throw new CodexTerminalResponseError(
				incomplete ? "incomplete" : "failed",
				incomplete ? event.response?.incomplete_details?.reason : event.response?.error?.code,
			)
		}

		if (event?.response?.output && Array.isArray(event.response.output)) {
			this.lastResponseOutput = event.response.output
		}
		if (event?.response?.id) {
			this.lastResponseId = event.response.id as string
		}

		// Handle text deltas
		if (event?.type === "response.text.delta" || event?.type === "response.output_text.delta") {
			if (event?.delta) {
				this.sawTextDeltaInCurrentResponse = true
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: event.delta }
			}
			return
		}

		if (event?.type === "response.text.done" || event?.type === "response.output_text.done") {
			const doneText =
				typeof event?.text === "string"
					? event.text
					: typeof event?.output_text === "string"
						? event.output_text
						: typeof event?.delta === "string"
							? event.delta
							: undefined
			if (!this.sawTextOutputInCurrentResponse && doneText) {
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: doneText }
			}
			return
		}

		if (event?.type === "response.content_part.added" || event?.type === "response.content_part.done") {
			const part = event?.part
			if (
				!this.sawTextDeltaInCurrentResponse &&
				(part?.type === "text" || part?.type === "output_text") &&
				(typeof part?.text === "string" || typeof part?.text?.value === "string")
			) {
				const partText = typeof part.text === "string" ? part.text : part.text.value
				if (partText) {
					this.sawTextOutputInCurrentResponse = true
					yield { type: "text", text: partText }
				}
			}
			return
		}

		// Handle reasoning deltas
		if (
			event?.type === "response.reasoning.delta" ||
			event?.type === "response.reasoning_text.delta" ||
			event?.type === "response.reasoning_summary.delta" ||
			event?.type === "response.reasoning_summary_text.delta"
		) {
			if (event?.delta) {
				yield { type: "reasoning", text: event.delta }
			}
			return
		}

		// Handle refusal deltas
		if (event?.type === "response.refusal.delta") {
			if (event?.delta) {
				this.sawTextOutputInCurrentResponse = true
				yield { type: "text", text: `[Refusal] ${event.delta}` }
			}
			return
		}

		// Handle tool/function call deltas
		if (
			event?.type === "response.tool_call_arguments.delta" ||
			event?.type === "response.function_call_arguments.delta"
		) {
			const call = this.resolveToolCall(event)
			const args = event.delta ?? event.arguments
			// The parser needs both the call ID and name to start a call.
			if (call?.callId && call.name && !call.completed) {
				yield {
					type: "tool_call_partial",
					index: call.streamIndex,
					id: call.callId,
					name: call.name,
					arguments: typeof args === "string" ? args : "",
				}
			}
			return
		}

		// Handle tool/function call completion
		if (
			event?.type === "response.tool_call_arguments.done" ||
			event?.type === "response.function_call_arguments.done"
		) {
			yield* this.completeToolCall(this.resolveToolCall(event), event.arguments)
			return
		}

		// Handle output item events
		if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
			const item = event?.item
			if (item) {
				if (item.type === "function_call" || item.type === "tool_call") {
					const call = this.resolveToolCall(event, item)
					yield* this.completeToolCall(
						call,
						event.type === "response.output_item.done"
							? (item.arguments ?? item.function?.arguments ?? item.input)
							: undefined,
					)
					return
				}

				// For "added" events, yield text/reasoning content (streaming path).
				// For "done" events, normally text was already streamed via deltas, but some models
				// only provide assistant text on done events. Emit fallback text only if none was emitted yet.
				if (event.type === "response.output_item.added") {
					if (item.type === "text" && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "output_text" && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "reasoning" && item.text) {
						yield { type: "reasoning", text: item.text }
					} else if (item.type === "message" && Array.isArray(item.content)) {
						for (const content of item.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				} else if (!this.sawTextOutputInCurrentResponse) {
					if ((item.type === "text" || item.type === "output_text") && item.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: item.text }
					} else if (item.type === "message" && Array.isArray(item.content)) {
						for (const content of item.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				}
			}
			return
		}

		// Handle completion events
		if (event?.type === "response.done" || event?.type === "response.completed") {
			// Some Codex variants only provide assistant text in the final completed payload.
			if (!this.sawTextOutputInCurrentResponse && Array.isArray(event?.response?.output)) {
				for (const outputItem of event.response.output) {
					if ((outputItem?.type === "text" || outputItem?.type === "output_text") && outputItem?.text) {
						this.sawTextOutputInCurrentResponse = true
						yield { type: "text", text: outputItem.text }
						continue
					}

					if (outputItem?.type === "message" && Array.isArray(outputItem.content)) {
						for (const content of outputItem.content) {
							if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
								this.sawTextOutputInCurrentResponse = true
								yield { type: "text", text: content.text }
							}
						}
					}
				}
			}

			const usage = event?.response?.usage || event?.usage || undefined
			const usageData = this.normalizeUsage(usage, model)
			if (usageData) {
				yield usageData
			}
			return
		}

		// Fallbacks
		if (event?.choices?.[0]?.delta?.content) {
			this.sawTextDeltaInCurrentResponse = true
			this.sawTextOutputInCurrentResponse = true
			yield { type: "text", text: event.choices[0].delta.content }
			return
		}

		if (event?.usage) {
			const usageData = this.normalizeUsage(event.usage, model)
			if (usageData) {
				yield usageData
			}
		}
	}

	private getReasoningEffort(model: OpenAiCodexModel): ReasoningEffortExtended | undefined {
		if (model.info.requiredReasoningEffort && Array.isArray(model.info.supportsReasoningEffort)) {
			const requested = this.options.reasoningEffort
			return requested && model.info.supportsReasoningEffort.includes(requested)
				? (requested as ReasoningEffortExtended)
				: model.info.reasoningEffort
		}
		const selected = (this.options.reasoningEffort as any) ?? (model.info.reasoningEffort as any)
		return selected && selected !== "disable" && selected !== "none" ? (selected as any) : undefined
	}

	override getModel() {
		const modelId = this.options.apiModelId

		let id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId

		const info: ModelInfo = openAiCodexModels[id]

		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, ...params }
	}

	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		if (!this.lastResponseOutput) return undefined

		const reasoningItem = this.lastResponseOutput.find(
			(item) => item.type === "reasoning" && item.encrypted_content,
		)

		if (!reasoningItem?.encrypted_content) return undefined

		return {
			encrypted_content: reasoningItem.encrypted_content,
			...(reasoningItem.id ? { id: reasoningItem.id } : {}),
		}
	}

	getResponseId(): string | undefined {
		return this.lastResponseId
	}

	async completePrompt(prompt: string): Promise<string> {
		this.abortController = new AbortController()

		try {
			const model = this.getModel()

			// Get access token
			const accessToken = await openAiCodexOAuthManager.getAccessToken()
			if (!accessToken) {
				throw new Error(
					t("common:errors.openAiCodex.notAuthenticated", {
						defaultValue:
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
					}),
				)
			}

			const reasoningEffort = this.getReasoningEffort(model)

			const requestBody: any = {
				model: model.id,
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: prompt }],
					},
				],
				stream: false,
				store: false,
				...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			}

			if (reasoningEffort) {
				requestBody.reasoning = {
					effort: reasoningEffort,
					summary: "auto" as const,
				}
			}

			const url = `${CODEX_API_BASE_URL}/responses`

			// Get ChatGPT account ID for organization subscriptions
			const accountId = await openAiCodexOAuthManager.getAccountId()

			// Build headers with required Codex-specific fields
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				originator: "roo-code",
				session_id: this.sessionId,
				// Codex backend parity: beta flag plus a client request id matching session_id.
				"OpenAI-Beta": "responses=experimental",
				"x-client-request-id": this.sessionId,
				"User-Agent": `roo-code/${Package.version} (${os.platform()} ${os.release()}; ${os.arch()}) node/${process.version.slice(1)}`,
			}

			// Add ChatGPT-Account-Id if available
			if (accountId) {
				headers["ChatGPT-Account-Id"] = accountId
			}

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					t("common:errors.openAiCodex.genericError", { status: response.status }) +
						(errorText ? `: ${errorText}` : ""),
				)
			}

			const responseData = await response.json()

			if (responseData?.output && Array.isArray(responseData.output)) {
				for (const outputItem of responseData.output) {
					if (outputItem.type === "message" && outputItem.content) {
						for (const content of outputItem.content) {
							if (content.type === "output_text" && content.text) {
								return content.text
							}
						}
					}
				}
			}

			if (responseData?.text) {
				return responseData.text
			}

			return ""
		} catch (error) {
			const errorModel = this.getModel()
			const errorMessage = error instanceof Error ? error.message : String(error)

			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.completionError", { message: error.message }))
			}
			throw error
		} finally {
			this.abortController = undefined
		}
	}
}
