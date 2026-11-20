// cd src && npx vitest run core/context-management/__tests__/context-management.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"
import * as condenseModule from "../../condense"

import { estimateTokenCount, truncateConversation, manageContext, willManageContext } from "../index"

// Create a mock ApiHandler for testing
class MockApiHandler extends BaseProvider {
	createMessage(): any {
		// Mock implementation for testing - returns an async iterable stream
		const mockStream = {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50 }
			},
		}
		return mockStream
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 100000,
				maxTokens: 50000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

// Create a singleton instance for tests
const mockApiHandler = new MockApiHandler()
const taskId = "test-task-id"

describe("Context Management", () => {
	beforeEach(() => {})
	/**
	 * Tests for the truncateConversation function
	 */
	describe("truncateConversation", () => {
		it("should retain the first message", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0.5, taskId)

			// With 2 messages after the first, 0.5 fraction means remove 1 message
			// But 1 is odd, so it rounds down to 0 (to make it even)
			// No truncation happens, so no marker is inserted
			expect(result.messages.length).toBe(3) // Original messages unchanged
			expect(result.messagesRemoved).toBe(0)
			expect(result.messages[0]).toEqual(messages[0])
			expect(result.messages[1]).toEqual(messages[1])
			expect(result.messages[2]).toEqual(messages[2])
		})

		it("should remove the specified fraction of messages (rounded to even number)", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
			]

			// 4 messages excluding first, 0.5 fraction = 2 messages to remove
			// 2 is already even, so no rounding needed
			const result = truncateConversation(messages, 0.5, taskId)

			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
			expect(result.messagesRemoved).toBe(2)
			expect(result.messages[0]).toEqual(messages[0])

			// Messages at indices 1 and 2 from original should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at index 3 (at the boundary, after truncated messages)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")

			// Messages at indices 3 and 4 from original should NOT be tagged (now at indices 4 and 5)
			expect(result.messages[4].truncationParent).toBeUndefined()
			expect(result.messages[5].truncationParent).toBeUndefined()
		})

		it("should round to an even number of messages to remove", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
				{ role: "assistant", content: "Sixth message" },
				{ role: "user", content: "Seventh message" },
			]

			// 6 messages excluding first, 0.3 fraction = 1.8 messages to remove
			// 1.8 rounds down to 1, then to 0 to make it even
			const result = truncateConversation(messages, 0.3, taskId)

			expect(result.messagesRemoved).toBe(0) // No messages removed
			// When nothing is truncated, no marker is inserted
			expect(result.messages.length).toBe(7) // Original messages unchanged
		})

		it("should handle edge case with fracToRemove = 0", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0, taskId)

			expect(result.messagesRemoved).toBe(0)
			// When nothing is truncated, no marker is inserted
			expect(result.messages.length).toBe(3) // Original messages unchanged
		})

		it("should handle edge case with fracToRemove = 1", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
			]

			// 3 messages excluding first, 1.0 fraction = 3 messages to remove
			// But 3 is odd, so it rounds down to 2 to make it even
			const result = truncateConversation(messages, 1, taskId)

			expect(result.messagesRemoved).toBe(2)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(5) // 4 original + 1 marker
			expect(result.messages[0]).toEqual(messages[0])

			// Messages at indices 1 and 2 should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at index 3 (at the boundary)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")

			// Last message should NOT be tagged (now at index 4)
			expect(result.messages[4].truncationParent).toBeUndefined()
		})
	})

	/**
	 * Tests for the estimateTokenCount function
	 */
	describe("estimateTokenCount", () => {
		it("should return 0 for empty or undefined content", async () => {
			expect(await estimateTokenCount([], mockApiHandler)).toBe(0)
			// @ts-ignore - Testing with undefined
			expect(await estimateTokenCount(undefined, mockApiHandler)).toBe(0)
		})

		it("should estimate tokens for text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "This is a text block with 36 characters" },
			]

			// With tiktoken, the exact token count may differ from character-based estimation
			// Instead of expecting an exact number, we verify it's a reasonable positive number
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(0)

			// We can also verify that longer text results in more tokens
			const longerContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{
					type: "text",
					text: "This is a longer text block with significantly more characters to encode into tokens",
				},
			]
			const longerResult = await estimateTokenCount(longerContent, mockApiHandler)
			expect(longerResult).toBeGreaterThan(result)
		})

		it("should estimate tokens for image blocks based on data size", async () => {
			// Small image
			const smallImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "small_dummy_data" } },
			]
			// Larger image with more data
			const largerImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "X".repeat(1000) } },
			]

			// Verify the token count scales with the size of the image data
			const smallImageTokens = await estimateTokenCount(smallImage, mockApiHandler)
			const largerImageTokens = await estimateTokenCount(largerImage, mockApiHandler)

			// Small image should have some tokens
			expect(smallImageTokens).toBeGreaterThan(0)

			// Larger image should have proportionally more tokens
			expect(largerImageTokens).toBeGreaterThan(smallImageTokens)

			// Verify the larger image calculation matches our formula including the 50% fudge factor
			expect(largerImageTokens).toBe(48)
		})

		it("should estimate tokens for mixed content blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "A text block with 30 characters" },
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
				{ type: "text", text: "Another text with 24 chars" },
			]

			// We know image tokens calculation should be consistent
			const imageTokens = Math.ceil(Math.sqrt("dummy_data".length)) * 1.5

			// With tiktoken, we can't predict exact text token counts,
			// but we can verify the total is greater than just the image tokens
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(imageTokens)

			// Also test against a version with only the image to verify text adds tokens
			const imageOnlyContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
			]
			const imageOnlyResult = await estimateTokenCount(imageOnlyContent, mockApiHandler)
			expect(result).toBeGreaterThan(imageOnlyResult)
		})

		it("should handle empty text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [{ type: "text", text: "" }]
			expect(await estimateTokenCount(content, mockApiHandler)).toBe(0)
		})

		it("should handle plain string messages", async () => {
			const content = "This is a plain text message"
			expect(await estimateTokenCount([{ type: "text", text: content }], mockApiHandler)).toBeGreaterThan(0)
		})
	})

	/**
	 * Tests for the manageContext function
	 */
	describe("on-overflow policy", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "latest input" },
		]
		const options = {
			messages,
			totalTokens: 999999,
			contextWindow: 1000,
			maxTokens: 999,
			apiHandler: mockApiHandler,
			autoCondenseContext: true,
			autoCondenseContextPercent: 1,
			profileThresholds: { default: 1 },
			currentProfileId: "default",
			systemPrompt: "system",
			taskId,
		}
		afterEach(() => vi.restoreAllMocks())
		it.each([true, false])("never preflights at high estimated usage, enabled=%s", async (enabled) => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation")
			expect(willManageContext({ ...options, autoCondenseContext: enabled, lastMessageTokens: 999999 })).toBe(
				false,
			)
			expect((await manageContext({ ...options, autoCondenseContext: enabled })).messages).toBe(messages)
			expect(summarize).not.toHaveBeenCalled()
		})
		it("disabled means no automatic summary or truncation even after overflow", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation")
			expect(
				(await manageContext({ ...options, autoCondenseContext: false, contextLimitExceeded: true })).messages,
			).toBe(messages)
			expect(summarize).not.toHaveBeenCalled()
		})
		it("forces a summary at low usage and retains the latest input", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [{ role: "user", content: "summary", isSummary: true }],
				summary: "summary",
				cost: 0,
			})
			const result = await manageContext({
				...options,
				contextWindow: 100_000,
				maxTokens: 10_000,
				totalTokens: 1,
				contextLimitExceeded: true,
			})
			expect(summarize.mock.calls[0][0].messages).toEqual(messages.slice(0, -1))
			expect(result.messages.at(-1)).toBe(messages.at(-1))
			expect(result.summary).toBe("summary")
			expect(messages.every((message) => !message.condenseParent)).toBe(true)
		})
		it("keeps the latest tool call and result paired outside the summary", async () => {
			const history: ApiMessage[] = [
				...messages.slice(0, 2),
				{ role: "user", content: "read it" },
				{ role: "assistant", content: [{ type: "tool_use", id: "tool", name: "read_file", input: {} }] },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "file contents" }] },
			]
			const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [{ role: "user", content: "summary", isSummary: true }],
				summary: "summary",
				cost: 0,
			})
			const result = await manageContext({ ...options, messages: history, contextLimitExceeded: true })
			expect(summarize.mock.calls[0][0].messages).toEqual(history.slice(0, 3))
			expect(result.messages.slice(-2)).toEqual(history.slice(-2))
		})
		it("does not fall back to truncation on summarization failure", async () => {
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [],
				summary: "",
				cost: 0,
				error: "provider limit",
			})
			const result = await manageContext({ ...options, contextLimitExceeded: true })
			expect(result.messages).toBe(messages)
			expect(result.error).toBe("provider limit")
		})
	})

	describe("tool-result pruning before summary", () => {
		const big = "x".repeat(20_000)
		const history: ApiMessage[] = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: big }] },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "latest input" },
		]
		const base = {
			messages: history,
			totalTokens: 50_000,
			contextWindow: 100_000,
			maxTokens: 10_000,
			apiHandler: mockApiHandler,
			autoCondenseContext: true,
			contextLimitExceeded: true,
			systemPrompt: "system",
			taskId,
		}
		const summaryResult = {
			messages: [{ role: "user" as const, content: "summary", isSummary: true }],
			summary: "summary",
			cost: 0.01,
			condenseId: "c1",
		}
		afterEach(() => vi.restoreAllMocks())

		it("returns a prune-only result and skips the summary when the estimate fits", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation")
			vi.spyOn(mockApiHandler, "countTokens").mockResolvedValue(1_000)
			const saveArtifact = vi.fn(async () => "tool-1.txt")
			const result = await manageContext({ ...base, saveArtifact })
			expect(summarize).not.toHaveBeenCalled()
			expect(saveArtifact).toHaveBeenCalledWith(big)
			expect(result.pruneId).toEqual(expect.any(String))
			expect(result.prunedCount).toBe(1)
			expect(result.summary).toBe("")
			expect(result.newContextTokens).toBe(1_000)
			expect(JSON.stringify(result.messages[2])).toContain("tool result middle pruned")
			expect(result.messages.at(-1)).toBe(history.at(-1))
		})

		it("summarizes the pruned history when the estimate is still too large", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue(summaryResult)
			vi.spyOn(mockApiHandler, "countTokens").mockResolvedValue(90_000)
			const result = await manageContext({ ...base, saveArtifact: async () => "tool-1.txt" })
			expect(summarize).toHaveBeenCalledTimes(1)
			expect(JSON.stringify(summarize.mock.calls[0][0].messages)).toContain("tool result middle pruned")
			expect(result.pruneId).toBeUndefined()
			expect(result.summary).toBe("summary")
		})

		it("falls through to the summary when countTokens throws", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue(summaryResult)
			vi.spyOn(mockApiHandler, "countTokens")
				.mockRejectedValueOnce(new Error("count failed"))
				.mockResolvedValue(10)
			const result = await manageContext({ ...base, saveArtifact: async () => "tool-1.txt" })
			expect(summarize).toHaveBeenCalledTimes(1)
			expect(result.summary).toBe("summary")
			expect(result.error).toBeUndefined()
		})

		it("skips pruning when disabled", async () => {
			const summarize = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue(summaryResult)
			const saveArtifact = vi.fn(async () => "tool-1.txt")
			await manageContext({ ...base, pruneToolResults: false, saveArtifact })
			expect(saveArtifact).not.toHaveBeenCalled()
			expect(summarize.mock.calls[0][0].messages).toEqual(history.slice(0, 4))
		})
	})

	describe("post-summary bound (r88: condense grew 75,923 -> 128,376 on a 64k window)", () => {
		// Count about 1 token per 4 characters of text, including tool-result text.
		const charCount = async (blocks: Anthropic.Messages.ContentBlockParam[]) =>
			Math.ceil(
				blocks.reduce((sum, block) => {
					if (block.type === "text") return sum + block.text.length
					if (block.type === "tool_result")
						return (
							sum +
							(typeof block.content === "string"
								? block.content.length
								: (block.content ?? []).reduce(
										(n, part) => n + (part.type === "text" ? part.text.length : 0),
										0,
									))
						)
					return sum + JSON.stringify(block).length
				}, 0) / 4,
			)
		// 64k override window; reserve 12,800 (20% cap), so input limit 51,200 and budget 46,080.
		const window = { contextWindow: 64_000, maxTokens: 12_800 }
		const huge = "line of Task.ts source code\n".repeat(8_000) // about 224,000 chars, about 56,000 tokens
		const history: ApiMessage[] = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "small" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "b", name: "read_file", input: { offset: 2001 } }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: huge }] },
		]
		const base = {
			messages: history,
			totalTokens: 40_000,
			...window,
			apiHandler: mockApiHandler,
			autoCondenseContext: true,
			contextLimitExceeded: true,
			systemPrompt: "system",
			taskId,
		}
		const summaryResult = {
			messages: [...history.slice(0, 3), { role: "user" as const, content: "summary", isSummary: true }],
			summary: "summary",
			cost: 0.05,
			condenseId: "c1",
			newContextTokens: 3_000,
		}
		afterEach(() => vi.restoreAllMocks())

		it("shortens the huge newest tool result in the kept tail and reports the true size", async () => {
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue(summaryResult)
			vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
			const saveArtifact = vi.fn(async () => "tool-tail.txt")
			const result = await manageContext({ ...base, saveArtifact })
			expect(result.error).toBeUndefined()
			expect(result.condenseId).toBe("c1")
			expect(saveArtifact).toHaveBeenCalledWith(huge)
			const tail = result.messages.at(-1)!
			expect(JSON.stringify(tail)).toContain("tool result middle pruned")
			expect(JSON.stringify(tail)).toContain("tool-tail.txt")
			// The tool pair stays intact.
			expect(result.messages.at(-2)).toBe(history[3])
			expect(result.prunedCount).toBe(1)
			// Final context fits the overridden window and is smaller than before.
			expect(result.newContextTokens!).toBeLessThanOrEqual((64_000 - 12_800) * 0.9)
			// prev is the measured pre-recovery prompt (includes the huge result), not the stale 40,000.
			expect(result.prevContextTokens).toBeGreaterThan(50_000)
			expect(result.newContextTokens!).toBeLessThan(result.prevContextTokens)
		})

		it("refuses to send when the summary does not shrink the context and nothing more can be cut", async () => {
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue(summaryResult)
			vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
			// Pruning disabled: the kept tail cannot be reduced.
			const result = await manageContext({ ...base, pruneToolResults: false, saveArtifact: async () => "x" })
			expect(result.error).toContain("still too large after automatic recovery")
			expect(result.messages).toBe(history)
			expect(result.cost).toBe(0.05)
		})

		it("leaves the kept tail unchanged when the summary already fits", async () => {
			const small: ApiMessage[] = [
				...history.slice(0, 4),
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "x".repeat(20_000) }] },
			]
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				...summaryResult,
				messages: [...small.slice(0, 3), { role: "user", content: "summary", isSummary: true }],
			})
			vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
			const saveArtifact = vi.fn(async () => "never.txt")
			const result = await manageContext({ ...base, messages: small, saveArtifact })
			expect(saveArtifact).not.toHaveBeenCalled()
			expect(result.messages.at(-1)).toBe(small.at(-1))
			expect(result.prunedCount).toBeUndefined()
		})

		describe("first tool batch overflows (r90 D1: no earlier history to summarize)", () => {
			// r90 R1 shape: task prompt, two parallel reads, two ~120k-char results (~60k tokens).
			const bigA = "a".repeat(120_000)
			const bigB = "b".repeat(120_000)
			const firstBatch: ApiMessage[] = [
				{ role: "user", content: "Read ClineProvider.ts and Task.ts in full" },
				{
					role: "assistant",
					content: [
						{ type: "tool_use", id: "r1", name: "read_file", input: { path: "ClineProvider.ts" } },
						{ type: "tool_use", id: "r2", name: "read_file", input: { path: "Task.ts" } },
					],
				},
				{
					role: "user",
					content: [
						{ type: "tool_result", tool_use_id: "r1", content: bigA },
						{ type: "tool_result", tool_use_id: "r2", content: bigB },
					],
				},
			]
			const first = { ...base, messages: firstBatch }

			it("shortens the latest tool results and returns a prune result under the input limit", async () => {
				const summarize = vi.spyOn(condenseModule, "summarizeConversation")
				vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
				let n = 0
				const saveArtifact = vi.fn(async () => `tool-${++n}.txt`)
				const result = await manageContext({ ...first, saveArtifact })
				expect(result.error).toBeUndefined()
				expect(summarize).not.toHaveBeenCalled()
				expect(result.pruneId).toEqual(expect.any(String))
				expect(result.prunedCount).toBe(2)
				expect(saveArtifact).toHaveBeenCalledWith(bigA)
				expect(saveArtifact).toHaveBeenCalledWith(bigB)
				const latest = result.messages[2].content as Anthropic.Messages.ToolResultBlockParam[]
				expect(latest.map((block) => block.tool_use_id)).toEqual(["r1", "r2"])
				expect(String(latest[0].content)).toContain("tool result middle pruned")
				expect(String(latest[0].content)).toContain("tool-1.txt")
				expect(String(latest[1].content)).toContain("tool-2.txt")
				expect(String(latest[0].content).length).toBeLessThan(6_000)
				// The prompt and the tool calls are unchanged, so every pair stays intact.
				expect(result.messages.slice(0, 2)).toEqual(firstBatch.slice(0, 2))
				expect(result.messages).toHaveLength(3)
				expect(result.newContextTokens!).toBeLessThanOrEqual(64_000 - 12_800)
				expect(result.prevContextTokens).toBeGreaterThan(60_000)
				// The input history is not mutated.
				expect((firstBatch[2].content as any)[0].content).toBe(bigA)
			})

			it("returns the still-too-large error and leaves history unchanged when pruning is off", async () => {
				vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
				const saveArtifact = vi.fn(async () => "never.txt")
				const result = await manageContext({ ...first, pruneToolResults: false, saveArtifact })
				expect(saveArtifact).not.toHaveBeenCalled()
				expect(result.error).toContain("still too large after automatic recovery")
				expect(result.error).not.toContain("Not enough earlier history")
				expect(result.pruneId).toBeUndefined()
				expect(result.messages).toBe(firstBatch)
			})

			it("returns the still-too-large error when the pruned results still do not fit", async () => {
				vi.spyOn(mockApiHandler, "countTokens").mockImplementation(charCount)
				const ids = Array.from({ length: 50 }, (_, i) => `t${i}`)
				const many: ApiMessage[] = [
					firstBatch[0],
					{
						role: "assistant",
						content: ids.map((id) => ({ type: "tool_use" as const, id, name: "read_file", input: {} })),
					},
					{
						role: "user",
						content: ids.map((id) => ({
							type: "tool_result" as const,
							tool_use_id: id,
							content: "z".repeat(10_000),
						})),
					},
				]
				const result = await manageContext({ ...first, messages: many, saveArtifact: async () => "t.txt" })
				expect(result.error).toContain("still too large after automatic recovery")
				expect(result.error).toContain("the limit is 51200 for a 64000-token window")
				expect(result.pruneId).toBeUndefined()
				expect(result.messages).toBe(many)
			})
		})
	})

	describe("image offload before summary", () => {
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "QUJD" },
		}
		const history: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "task" }, image] },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: "more" },
			{ role: "assistant", content: "ok" },
			{ role: "user", content: [{ type: "text", text: "latest" }, image] },
		]
		const base = {
			messages: history,
			totalTokens: 50_000,
			contextWindow: 100_000,
			maxTokens: 10_000,
			apiHandler: mockApiHandler,
			autoCondenseContext: true,
			contextLimitExceeded: true,
			systemPrompt: "system",
			taskId,
		}
		afterEach(() => vi.restoreAllMocks())

		const withImages = (supportsImages: boolean) =>
			vi
				.spyOn(mockApiHandler, "getModel")
				.mockReturnValue({ id: "m", info: { contextWindow: 100_000, supportsImages } } as any)

		it("offloads old images after pruning and skips the summary when the estimate fits", async () => {
			withImages(true)
			const summarize = vi.spyOn(condenseModule, "summarizeConversation")
			vi.spyOn(mockApiHandler, "countTokens").mockResolvedValue(1_000)
			const saveImage = vi.fn(async (_d: string, _m: string, hash: string) => `/t/images/${hash}.png`)
			const result = await manageContext({ ...base, saveArtifact: async () => "tool-1.txt", saveImage })
			expect(summarize).not.toHaveBeenCalled()
			expect(saveImage).toHaveBeenCalledTimes(1)
			expect(result.pruneId).toEqual(expect.any(String))
			expect(result.prunedCount).toBe(0)
			expect(result.offloadedCount).toBe(1)
			expect(JSON.stringify(result.messages[0])).toContain("[Image offloaded:")
			expect(result.messages.at(-1)).toBe(history.at(-1))
		})

		it("keeps the offload count on the result when the summary still runs (D3)", async () => {
			withImages(true)
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [{ role: "user", content: "summary", isSummary: true }],
				summary: "summary",
				cost: 0.05,
				condenseId: "c1",
			})
			// Estimate stays over budget, so offload alone is not enough. The summary then fits.
			vi.spyOn(mockApiHandler, "countTokens").mockResolvedValueOnce(200_000).mockResolvedValue(1_000)
			const saveImage = vi.fn(async (_d: string, _m: string, hash: string) => `/t/images/${hash}.png`)
			const result = await manageContext({ ...base, saveArtifact: async () => "tool-1.txt", saveImage })
			expect(result.condenseId).toBe("c1")
			expect(result.pruneId).toBeUndefined()
			expect(result.offloadedCount).toBe(1)
			expect(result.prunedCount).toBeUndefined()
		})

		it("leaves images alone for models without image support", async () => {
			withImages(false)
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [{ role: "user", content: "summary", isSummary: true }],
				summary: "summary",
				cost: 0,
				condenseId: "c1",
			})
			const saveImage = vi.fn(async () => "/t/images/x.png")
			await manageContext({ ...base, saveImage })
			expect(saveImage).not.toHaveBeenCalled()
		})

		it("skips offload when disabled", async () => {
			withImages(true)
			vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [{ role: "user", content: "summary", isSummary: true }],
				summary: "summary",
				cost: 0,
				condenseId: "c1",
			})
			const saveImage = vi.fn(async () => "/t/images/x.png")
			await manageContext({ ...base, offloadImages: false, saveImage })
			expect(saveImage).not.toHaveBeenCalled()
		})
	})
})
