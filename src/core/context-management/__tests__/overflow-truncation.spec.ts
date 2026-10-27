import type { ApiHandler } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { getEffectiveApiHistory, summarizeConversation } from "../../condense"
import * as condense from "../../condense"
import { manageContext } from "../index"
import { truncateAfterOverflow } from "../overflow-truncation"

const user = (content: string): ApiMessage => ({ role: "user", content })
const assistant = (content: string): ApiMessage => ({ role: "assistant", content })
const toolGroup = (id: string, output = "output", name = "read_file"): ApiMessage[] => [
	{ role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
	{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: output }] },
]
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
	it.each([false, true])("recovers a single long tool chain (prior summary=%s)", async (priorSummary) => {
		const opts = options()
		opts.messages = [
			priorSummary
				? { ...user("current summary"), isSummary: true, condenseId: "summary" }
				: user("original task"),
			...Array.from({ length: 4 }, (_, index): ApiMessage[] => [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: `call-${index}`, name: "read_file", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: `call-${index}`, content: "important output" }],
				},
			]).flat(),
		]
		const before = structuredClone(opts.messages)
		const result = await truncateAfterOverflow(opts)
		expect(opts.messages).toEqual(before)
		expect(result.error).toBeUndefined()
		expect(result.messagesRemoved).toBe(2)
		const effective = getEffectiveApiHistory(result.messages)
		expect(effective[0]).toBe(opts.messages[0])
		expect(effective.slice(-2)).toEqual(opts.messages.slice(-2))
		expect(effective.some((message) => message.isTruncationMarker)).toBe(true)
		expect(effective.find((message) => message.isTruncationMarker)?.content).toContain("not summarized")
	})
	it("retains feedback, standalone user input, and interactive tool groups", async () => {
		const opts = options()
		opts.messages = [
			user("root"),
			...toolGroup("question", "answer without markup", "functions.ask_followup_question"),
			...toolGroup("feedback", "<user_message>Do not deploy</user_message>", "execute_command"),
			...toolGroup("nested"),
			...toolGroup("mixed"),
			...toolGroup("removable"),
			...toolGroup("latest"),
		]
		opts.messages[6].content = [
			{
				type: "tool_result",
				tool_use_id: "nested",
				content: [{ type: "text", text: "<feedback>Stop</feedback>" }],
			},
		]
		opts.messages[8].content = [
			{ type: "tool_result", tool_use_id: "mixed", content: "result" },
			{ type: "text", text: "Only local changes are approved" },
		]
		const result = await truncateAfterOverflow(opts)
		expect(result.messagesRemoved).toBe(2)
		const effective = getEffectiveApiHistory(result.messages).filter((message) => !message.isTruncationMarker)
		expect(effective).toEqual([...opts.messages.slice(0, 9), ...opts.messages.slice(-2)])
	})
	it("excludes parallel calls and split results together, including environment-only updates", async () => {
		const opts = options()
		opts.messages = [
			user("root"),
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "read_file", input: {} },
					{ type: "tool_use", id: "b", name: "read_file", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "b", content: "B" },
					{ type: "text", text: "<environment_details>old state</environment_details>" },
				],
			},
			...toolGroup("latest"),
		]
		const result = await truncateAfterOverflow(opts)
		expect(result.messagesRemoved).toBe(3)
		expect(getEffectiveApiHistory(result.messages).filter((message) => !message.isTruncationMarker)).toEqual([
			opts.messages[0],
			...opts.messages.slice(-2),
		])
	})
	it("uses tool groups if whole older turns still leave an oversized latest chain", async () => {
		const opts = options()
		opts.contextWindow = 100
		opts.maxTokens = 30
		opts.messages.push(...toolGroup("old-tool"), ...toolGroup("latest-tool"))
		const result = await truncateAfterOverflow(opts)
		expect(result.messagesRemoved).toBe(4)
		expect(result.newContextTokens).toBe(70)
		expect(getEffectiveApiHistory(result.messages).filter((message) => !message.isTruncationMarker)).toEqual([
			...opts.messages.slice(0, 2),
			opts.messages[4],
			...opts.messages.slice(-2),
		])
	})
	it("keeps earlier truncation markers effective and includes their token cost", async () => {
		const opts = options()
		opts.messages = [user("root"), ...toolGroup("a"), ...toolGroup("b"), ...toolGroup("c")]
		const first = await truncateAfterOverflow(opts)
		const second = await truncateAfterOverflow({ ...opts, messages: first.messages })
		expect(second.messagesRemoved).toBe(2)
		expect(second.newContextTokens).toBe(60)
		expect(getEffectiveApiHistory(second.messages).filter((message) => !message.isTruncationMarker)).toEqual([
			opts.messages[0],
			...opts.messages.slice(-2),
		])
		const third = await truncateAfterOverflow({ ...opts, messages: second.messages })
		expect(third.error).toBeTruthy()
		expect(third.messages).toBe(second.messages)
	})
	it("does not apply partial exclusions when the newest tool result cannot fit", async () => {
		const opts = options()
		opts.contextWindow = 100
		opts.maxTokens = 70
		opts.messages = [user("root"), ...toolGroup("old"), ...toolGroup("latest")]
		const before = structuredClone(opts.messages)
		const result = await truncateAfterOverflow(opts)
		expect(result.error).toContain("Nothing was truncated")
		expect(result.truncationId).toBeUndefined()
		expect(result.messages).toBe(opts.messages)
		expect(opts.messages).toEqual(before)
	})
	it.each(["duplicate-call", "duplicate-result", "pending"])("refuses ambiguous tool chains: %s", async (kind) => {
		const opts = options()
		opts.messages = [user("root"), ...toolGroup("old"), ...toolGroup("latest")]
		if (kind === "duplicate-call") opts.messages.push(...toolGroup("old"))
		if (kind === "duplicate-result") opts.messages.push(opts.messages[2])
		if (kind === "pending") opts.messages.splice(2, 1)
		const result = await truncateAfterOverflow(opts)
		expect(result.error).toBeTruthy()
		expect(result.messages).toBe(opts.messages)
		expect(opts.apiHandler.countTokens).not.toHaveBeenCalled()
	})
	it("does not exclude either of two protected user turns", async () => {
		const opts = options()
		opts.messages = [user("root"), assistant("answer"), user("latest"), assistant("followup"), user("more input")]
		// Consecutive user inputs belong to the same newest turn.
		opts.messages.splice(3, 1)
		const result = await truncateAfterOverflow(opts)
		expect(result.error).toContain("Nothing was truncated")
		expect(result.messages).toBe(opts.messages)
		expect(result.truncationId).toBeUndefined()
	})
	it.each(["context-limit", "empty-summary"] as const)(
		"preserves %s diagnostics when truncation is refused",
		async (failureKind) => {
			const opts = options()
			opts.messages = [user("root"), assistant("answer"), user("latest"), user("continued input")]
			const before = structuredClone(opts.messages)
			const summary = vi.spyOn(condense, "summarizeConversation").mockResolvedValue({
				messages: [],
				summary: "",
				cost: 0.02,
				error: "Original summary failure",
				errorDetails: "summary diagnostics",
				failureKind,
			})
			const result = await manageContext({
				...opts,
				totalTokens: 900,
				autoCondenseContext: true,
				contextLimitExceeded: true,
				taskId: "task",
			})
			expect(summary).toHaveBeenCalledTimes(1)
			expect(result.error).toContain("Original summary failure")
			expect(result.error).toContain("Nothing was truncated")
			expect(result).toMatchObject({
				cost: 0.02,
				errorDetails: "summary diagnostics",
				fallbackReason: failureKind,
			})
			expect(result.messages).toBe(opts.messages)
			expect(opts.messages).toEqual(before)
			expect(result.truncationId).toBeUndefined()
		},
	)
	it.each(["context-limit", "empty-summary"] as const)(
		"honors disabled fallback after %s without changing stored history",
		async (failureKind) => {
			const opts = options()
			const before = structuredClone(opts.messages)
			vi.spyOn(condense, "summarizeConversation").mockResolvedValue({
				messages: opts.messages,
				summary: "",
				cost: 0.01,
				error: "compaction failed",
				failureKind,
			})
			const result = await manageContext({
				...opts,
				totalTokens: 900,
				autoCondenseContext: true,
				contextLimitExceeded: true,
				allowOverflowTruncation: false,
				taskId: "task",
			})
			expect(result.truncationId).toBeUndefined()
			expect(result.messages).toEqual(before)
			expect(result.error).toContain("Automatic truncation fallback is disabled")
			expect(result.cost).toBe(0.01)
		},
	)
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
