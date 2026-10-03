// pnpm --filter roo-cline test api/providers/__tests__/openrouter.spec.ts

vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn(() => ({ get: vitest.fn(() => undefined) })),
	},
}))

import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import { OpenRouterHandler } from "../openrouter"
import { ApiHandlerOptions } from "../../../shared/api"
import { Package } from "../../../shared/package"
import { normalizeSnapshotMessages } from "../../../core/task/model-operation/normalization"

vitest.mock("openai")
vitest.mock("delay", () => ({ default: vitest.fn(() => Promise.resolve()) }))

vitest.mock("../fetchers/modelCache", () => ({
	getModels: vitest.fn().mockImplementation(() => {
		return Promise.resolve({
			"anthropic/claude-sonnet-4": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet",
				thinking: false,
			},
			"anthropic/claude-sonnet-4.5": {
				maxTokens: 8192,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 4.5 Sonnet",
				thinking: false,
			},
			"anthropic/claude-3.7-sonnet:thinking": {
				maxTokens: 128000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: true,
				inputPrice: 3,
				outputPrice: 15,
				cacheWritesPrice: 3.75,
				cacheReadsPrice: 0.3,
				description: "Claude 3.7 Sonnet with thinking",
			},
			"openai/gpt-4o": {
				maxTokens: 16384,
				contextWindow: 128000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 2.5,
				outputPrice: 10,
				description: "GPT-4o",
			},
			"openai/o1": {
				maxTokens: 100000,
				contextWindow: 200000,
				supportsImages: true,
				supportsPromptCache: false,
				inputPrice: 15,
				outputPrice: 60,
				description: "OpenAI o1",
				excludedTools: ["existing_excluded"],
				includedTools: ["existing_included"],
			},
		})
	}),
}))

describe("OpenRouterHandler", () => {
	const mockOptions: ApiHandlerOptions = {
		openRouterApiKey: "test-key",
		openRouterModelId: "anthropic/claude-sonnet-4",
	}

	beforeEach(() => vitest.clearAllMocks())

	it("initializes with correct options", () => {
		const handler = new OpenRouterHandler(mockOptions)
		expect(handler).toBeInstanceOf(OpenRouterHandler)

		expect(OpenAI).toHaveBeenCalledWith({
			baseURL: "https://openrouter.ai/api/v1",
			apiKey: mockOptions.openRouterApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://github.com/RooVetGit/Roo-Cline",
				"X-Title": "Roo Code",
				"User-Agent": `RooCode/${Package.version}`,
			},
		})
	})

	describe("fetchModel", () => {
		it("returns correct model info when options are provided", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const result = await handler.fetchModel()

			expect(result).toMatchObject({
				id: mockOptions.openRouterModelId,
				maxTokens: 8192,
				temperature: 0,
				reasoningEffort: undefined,
				topP: undefined,
			})
		})

		it("returns default model info when options are not provided", async () => {
			const handler = new OpenRouterHandler({})
			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4.5")
			expect(result.info.supportsPromptCache).toBe(true)
		})

		it("honors custom maxTokens for thinking models", async () => {
			const handler = new OpenRouterHandler({
				openRouterApiKey: "test-key",
				openRouterModelId: "anthropic/claude-3.7-sonnet:thinking",
				modelMaxTokens: 32_768,
				modelMaxThinkingTokens: 16_384,
			})

			const result = await handler.fetchModel()
			// With the new clamping logic, 128000 tokens (64% of 200000 context window)
			// gets clamped to 20% of context window: 200000 * 0.2 = 40000
			expect(result.maxTokens).toBe(40000)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("does not honor custom maxTokens for non-thinking models", async () => {
			const handler = new OpenRouterHandler({
				...mockOptions,
				modelMaxTokens: 32_768,
				modelMaxThinkingTokens: 16_384,
			})

			const result = await handler.fetchModel()
			expect(result.maxTokens).toBe(8192)
			expect(result.reasoningBudget).toBeUndefined()
			expect(result.temperature).toBe(0)
		})

		it("adds excludedTools and includedTools for OpenAI models", async () => {
			const handler = new OpenRouterHandler({
				openRouterApiKey: "test-key",
				openRouterModelId: "openai/gpt-4o",
			})

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/gpt-4o")
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			expect(result.info.includedTools).toContain("apply_patch")
		})

		it("merges excludedTools and includedTools with existing values for OpenAI models", async () => {
			const handler = new OpenRouterHandler({
				openRouterApiKey: "test-key",
				openRouterModelId: "openai/o1",
			})

			const result = await handler.fetchModel()
			expect(result.id).toBe("openai/o1")
			// Should have the new exclusions
			expect(result.info.excludedTools).toContain("apply_diff")
			expect(result.info.excludedTools).toContain("write_to_file")
			// Should preserve existing exclusions
			expect(result.info.excludedTools).toContain("existing_excluded")
			// Should have the new inclusions
			expect(result.info.includedTools).toContain("apply_patch")
			// Should preserve existing inclusions
			expect(result.info.includedTools).toContain("existing_included")
		})

		it("does not add excludedTools or includedTools for non-OpenAI models", async () => {
			const handler = new OpenRouterHandler({
				openRouterApiKey: "test-key",
				openRouterModelId: "anthropic/claude-sonnet-4",
			})

			const result = await handler.fetchModel()
			expect(result.id).toBe("anthropic/claude-sonnet-4")
			// Should NOT have the tool exclusions/inclusions
			expect(result.info.excludedTools).toBeUndefined()
			expect(result.info.includedTools).toBeUndefined()
		})
	})

	describe("createMessage", () => {
		it("sends complete imported Gemini batches with sentinel signatures and preserves subsequent native signatures", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			vitest.spyOn(handler, "fetchModel").mockResolvedValue({
				...(await handler.fetchModel()),
				id: "google/gemini-3-flash-preview",
			})
			const mockCreate = vitest.fn().mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { choices: [{ delta: { content: "Continuing" } }] }
				},
			})
			;(OpenAI as any).prototype.chat = { completions: { create: mockCreate } }
			const imported = normalizeSnapshotMessages([
				{ role: "user", content: "Inspect the files." },
				{
					role: "assistant",
					reasoning_details: [{ type: "reasoning.encrypted", data: "foreign-reasoning" }],
					content: [
						{ type: "text", text: "Reading both files." },
						{
							type: "tool_use",
							id: "toolu_source",
							name: "read_file",
							input: { path: "src/main.ts", lines: { start: 1, end: 10 } },
						},
						{ type: "tool_use", id: "call_missing", name: "read_file", input: { path: "missing.ts" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_missing",
							content: [
								{ type: "text", text: "ENOENT" },
								{ type: "text", text: "missing.ts" },
							],
							is_error: true,
						},
						{ type: "tool_result", tool_use_id: "toolu_source", content: "const value = 42\n" },
						{ type: "text", text: "Continue with the source." },
					],
				},
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "call_empty", name: "execute_command", input: { command: "true" } },
					],
				},
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_empty", content: "" }] },
			])
			const nativeDetails = [
				{
					type: "reasoning.encrypted",
					data: "native-signature-a",
					id: "native_a",
					format: "google-gemini-v1",
					index: 0,
				},
				{
					type: "reasoning.encrypted",
					data: "native-signature-b",
					id: "native_b",
					format: "google-gemini-v1",
					index: 0,
				},
			]
			// Only the imported prefix is normalized. Later target-native metadata is retained.
			const messages: Anthropic.Messages.MessageParam[] = [
				...imported,
				{
					role: "assistant",
					reasoning_details: nativeDetails,
					content: [
						{ type: "tool_use", id: "native_a", name: "read_file", input: { path: "a.ts" } },
						{ type: "tool_use", id: "native_b", name: "read_file", input: { path: "b.ts" } },
					],
				} as Anthropic.Messages.MessageParam,
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "native_b", content: "B" },
						{ type: "tool_result", tool_use_id: "native_a", content: "A" },
					],
				},
			]
			const before = structuredClone(messages)
			await handler.createMessage("System", messages).next()

			expect(mockCreate).toHaveBeenCalledOnce()
			expect(mockCreate.mock.calls[0][0].messages).toEqual([
				{ role: "system", content: "System" },
				{ role: "user", content: "Inspect the files." },
				{
					role: "assistant",
					content: "Reading both files.",
					tool_calls: [
						{
							id: "toolu_source",
							type: "function",
							function: {
								name: "read_file",
								arguments: '{"path":"src/main.ts","lines":{"start":1,"end":10}}',
							},
						},
						{
							id: "call_missing",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"missing.ts"}' },
						},
					],
					reasoning_details: [
						{
							type: "reasoning.encrypted",
							data: "skip_thought_signature_validator",
							id: "toolu_source",
							format: "google-gemini-v1",
							index: 0,
						},
					],
				},
				{ role: "tool", tool_call_id: "call_missing", content: "ENOENT\nmissing.ts" },
				{ role: "tool", tool_call_id: "toolu_source", content: "const value = 42\n" },
				{ role: "user", content: [{ type: "text", text: "Continue with the source." }] },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "call_empty",
							type: "function",
							function: { name: "execute_command", arguments: '{"command":"true"}' },
						},
					],
					reasoning_details: [
						{
							type: "reasoning.encrypted",
							data: "skip_thought_signature_validator",
							id: "call_empty",
							format: "google-gemini-v1",
							index: 0,
						},
					],
				},
				{ role: "tool", tool_call_id: "call_empty", content: "(empty)" },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "native_a",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"a.ts"}' },
						},
						{
							id: "native_b",
							type: "function",
							function: { name: "read_file", arguments: '{"path":"b.ts"}' },
						},
					],
					reasoning_details: nativeDetails,
				},
				{ role: "tool", tool_call_id: "native_b", content: "B" },
				{ role: "tool", tool_call_id: "native_a", content: "A" },
			])
			expect(messages).toEqual(before)
		})

		it("generates correct stream chunks", async () => {
			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: mockOptions.openRouterModelId,
						choices: [{ delta: { content: "test response" } }],
					}
					yield {
						id: "test-id",
						choices: [{ delta: {} }],
						usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001 },
					}
				},
			}

			// Mock OpenAI chat.completions.create
			const mockCreate = vitest.fn().mockResolvedValue(mockStream)

			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const systemPrompt = "test system prompt"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user" as const, content: "test message" }]

			const generator = handler.createMessage(systemPrompt, messages)
			const chunks = []

			for await (const chunk of generator) {
				chunks.push(chunk)
			}

			// Verify stream chunks
			expect(chunks).toHaveLength(2) // One text chunk and one usage chunk
			expect(chunks[0]).toEqual({ type: "text", text: "test response" })
			expect(chunks[1]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 20, totalCost: 0.001 })

			// Verify OpenAI client was called with correct parameters.
			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					max_tokens: 8192,
					messages: [
						{
							content: [
								{ cache_control: { type: "ephemeral" }, text: "test system prompt", type: "text" },
							],
							role: "system",
						},
						{
							content: [{ cache_control: { type: "ephemeral" }, text: "test message", type: "text" }],
							role: "user",
						},
					],
					model: "anthropic/claude-sonnet-4",
					stream: true,
					stream_options: { include_usage: true },
					temperature: 0,
					top_p: undefined,
				}),
				{ headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" } },
			)
		})

		it("adds cache control for supported models", async () => {
			const handler = new OpenRouterHandler({
				...mockOptions,
				openRouterModelId: "anthropic/claude-3.5-sonnet",
			})

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [{ delta: { content: "test response" } }],
					}
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const messages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "message 1" },
				{ role: "assistant", content: "response 1" },
				{ role: "user", content: "message 2" },
			]

			await handler.createMessage("test system", messages).next()

			expect(mockCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: expect.arrayContaining([
								expect.objectContaining({ cache_control: { type: "ephemeral" } }),
							]),
						}),
					]),
				}),
				{ headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" } },
			)
		})

		it("handles API errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { error: { message: "API Error", code: 500 } }
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 500: API Error")
		})

		it("propagates createMessage exceptions", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockCreate = vitest.fn().mockRejectedValue(new Error("Connection failed"))
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow()
		})

		it("propagates SDK exceptions with status 429", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Rate limit exceeded: free-models-per-day") as any
			error.status = 429

			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("Rate limit exceeded")
		})

		it("propagates SDK exceptions with 429 in the message", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("429 Rate limit exceeded")
		})

		it("propagates SDK exceptions containing 'rate limit'", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("rate limit")
		})

		it("propagates 429 rate limit errors from stream", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield { error: { message: "Rate limit exceeded", code: 429 } }
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			await expect(generator.next()).rejects.toThrow("OpenRouter API Error 429: Rate limit exceeded")
		})

		it("yields tool_call_end events when finish_reason is tool_calls", async () => {
			// Import NativeToolCallParser to set up state
			const { NativeToolCallParser } = await import("../../../core/assistant-message/NativeToolCallParser")

			// Clear any previous state
			NativeToolCallParser.clearRawChunkState()

			const handler = new OpenRouterHandler(mockOptions)

			const mockStream = {
				async *[Symbol.asyncIterator]() {
					yield {
						id: "test-id",
						choices: [
							{
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_openrouter_test",
											function: { name: "read_file", arguments: '{"path":"test.ts"}' },
										},
									],
								},
								index: 0,
							},
						],
					}
					yield {
						id: "test-id",
						choices: [
							{
								delta: {},
								finish_reason: "tool_calls",
								index: 0,
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
					}
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockStream)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const generator = handler.createMessage("test", [])
			const chunks = []

			for await (const chunk of generator) {
				// Simulate what Task.ts does: when we receive tool_call_partial,
				// process it through NativeToolCallParser to populate rawChunkTracker
				if (chunk.type === "tool_call_partial") {
					NativeToolCallParser.processRawChunk({
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					})
				}
				chunks.push(chunk)
			}

			// Should have tool_call_partial and tool_call_end
			const partialChunks = chunks.filter((chunk) => chunk.type === "tool_call_partial")
			const endChunks = chunks.filter((chunk) => chunk.type === "tool_call_end")

			expect(partialChunks).toHaveLength(1)
			expect(endChunks).toHaveLength(1)
			expect(endChunks[0].id).toBe("call_openrouter_test")
		})
	})

	describe("completePrompt", () => {
		it("returns correct response", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockResponse = { choices: [{ message: { content: "test completion" } }] }

			const mockCreate = vitest.fn().mockResolvedValue(mockResponse)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			const result = await handler.completePrompt("test prompt")

			expect(result).toBe("test completion")

			expect(mockCreate).toHaveBeenCalledWith(
				{
					model: mockOptions.openRouterModelId,
					max_tokens: 8192,
					temperature: 0,
					messages: [{ role: "user", content: "test prompt" }],
					stream: false,
				},
				{ headers: { "x-anthropic-beta": "fine-grained-tool-streaming-2025-05-14" } },
			)
		})

		it("handles API errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "API Error",
					code: 500,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("OpenRouter API Error 500: API Error")
		})

		it("handles unexpected errors", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Unexpected error")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Unexpected error")
		})

		it("propagates SDK exceptions with status 429", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Rate limit exceeded: free-models-per-day") as any
			error.status = 429
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("Rate limit exceeded")
		})

		it("propagates SDK exceptions with 429 in the message", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("429 Rate limit exceeded: free-models-per-day")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("429 Rate limit exceeded")
		})

		it("propagates SDK exceptions containing 'rate limit'", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const error = new Error("Request failed due to rate limit")
			const mockCreate = vitest.fn().mockRejectedValue(error)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow("rate limit")
		})

		it("propagates 429 rate limit errors from response", async () => {
			const handler = new OpenRouterHandler(mockOptions)
			const mockError = {
				error: {
					message: "Rate limit exceeded",
					code: 429,
				},
			}

			const mockCreate = vitest.fn().mockResolvedValue(mockError)
			;(OpenAI as any).prototype.chat = {
				completions: { create: mockCreate },
			} as any

			await expect(handler.completePrompt("test prompt")).rejects.toThrow(
				"OpenRouter API Error 429: Rate limit exceeded",
			)
		})
	})
})
