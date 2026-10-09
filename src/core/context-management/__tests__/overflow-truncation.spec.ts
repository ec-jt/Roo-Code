import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory, summarizeConversation } from "../../condense"
import * as condense from "../../condense"
import { manageContext } from "../index"
import { truncateAfterOverflow } from "../overflow-truncation"

const user = (content: string): ApiMessage => ({ role: "user", content })
const assistant = (content: string): ApiMessage => ({ role: "assistant", content })
const history = (): ApiMessage[] => [
	user("original task"),
	assistant("root answer"),
	user("old request"),
	assistant("old answer"),
	user("latest input"),
]
const handler = () =>
	({
		countTokens: vi.fn(async () => 10),
		getModel: () => ({ id: "test", info: { supportsImages: false } }),
	}) as unknown as ApiHandler
const options = () => ({
	messages: history(),
	apiHandler: handler(),
	systemPrompt: "system",
	contextWindow: 1000,
	maxTokens: 100,
})

describe("overflow truncation fallback", () => {
	afterEach(() => vi.restoreAllMocks())
	it("tags complete older exchanges, retains root/latest, and leaves original objects unchanged", async () => {
		const opts = options()
		const before = structuredClone(opts.messages)
		const result = await truncateAfterOverflow(opts)
		expect(result).toMatchObject({ messagesRemoved: 2, truncationId: expect.any(String) })
		expect(opts.messages).toEqual(before)
		expect(result.messages).toHaveLength(6)
		expect(getEffectiveApiHistory(result.messages).filter((message) => !message.isTruncationMarker)).toEqual([
			before[0],
			before[1],
			before[4],
		])
	})
	it("keeps multi-call/result chains with the newest user turn", async () => {
		const opts = options()
		opts.messages.push(
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "read_file", input: {} },
					{ type: "tool_use", id: "b", name: "read_file", input: {} },
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "a", content: "A" },
					{ type: "tool_result", tool_use_id: "b", content: "B" },
				],
			},
			{ role: "assistant", content: [{ type: "tool_use", id: "c", name: "read_file", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "C" }] },
		)
		const result = await truncateAfterOverflow(opts)
		expect(result.messages.slice(-5)).toEqual(opts.messages.slice(-5))
		expect(result.messagesRemoved).toBe(2)
	})
	it("handles earlier condensation without resurrecting hidden messages", async () => {
		const opts = options()
		opts.messages = [
			user("hidden original"),
			{ ...user("summary"), isSummary: true, condenseId: "summary" },
			...opts.messages.slice(1),
		]
		const result = await truncateAfterOverflow(opts)
		expect(result.messagesRemoved).toBe(2)
		expect(getEffectiveApiHistory(result.messages)[0].content).toBe("summary")
		expect(result.messages[0].content).toBe("hidden original")
	})
	it.each(["latest too large", "unpaired result", "pending call", "too short"])(
		"refuses %s without mutating history",
		async (kind) => {
			const opts = options()
			if (kind === "latest too large") vi.mocked(opts.apiHandler.countTokens).mockResolvedValue(500)
			if (kind === "unpaired result")
				opts.messages.push({
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "missing", content: "x" }],
				})
			if (kind === "pending call")
				opts.messages.splice(3, 1, {
					role: "assistant",
					content: [{ type: "tool_use", id: "pending", name: "read_file", input: {} }],
				})
			if (kind === "too short") opts.messages = opts.messages.slice(0, 3)
			const before = structuredClone(opts.messages)
			const result = await truncateAfterOverflow(opts)
			expect(result.error).toBeTruthy()
			expect(result.messages).toEqual(before)
		},
	)
	it.each(["context-limit", "empty-summary"] as const)(
		"falls back only for explicitly classified %s after overflow",
		async (failureKind) => {
			const opts = options()
			const summary = vi
				.spyOn(condense, "summarizeConversation")
				.mockResolvedValue({ messages: [], summary: "", cost: 0.01, error: "failed", failureKind })
			const request = { ...opts, totalTokens: 900, autoCondenseContext: true, taskId: "task" }
			expect((await manageContext(request)).truncationId).toBeUndefined()
			expect(summary).not.toHaveBeenCalled()
			const result = await manageContext({ ...request, contextLimitExceeded: true })
			expect(result).toMatchObject({ truncationId: expect.any(String), fallbackReason: failureKind, cost: 0.01 })
		},
	)
	it.each([401, 403, 429, 500])("does not classify HTTP %i as truncation-eligible", async (status) => {
		const apiHandler = {
			...handler(),
			createMessage: async function* () {
				yield { type: "usage" as const, inputTokens: 0, outputTokens: 0 }
				throw Object.assign(new Error("provider failure"), { status })
			},
		} as ApiHandler
		const result = await summarizeConversation({
			messages: history(),
			apiHandler,
			systemPrompt: "system",
			taskId: "task",
		})
		expect(result.error).toBeTruthy()
		expect(result.failureKind).toBeUndefined()
	})
})
