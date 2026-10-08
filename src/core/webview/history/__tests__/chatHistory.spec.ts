import type { ClineMessage } from "@roo-code/types"
import { consolidateApiRequests } from "../../../../../packages/core/src/message-utils/consolidateApiRequests"
import { consolidateTokenUsage } from "../../../../../packages/core/src/message-utils/consolidateTokenUsage"
import { ChatHistoryIndex } from "../ChatHistoryIndex"
import { ChatWindow, CHAT_WINDOW_BYTES, utf8Preview } from "../ChatWindow"
import { ChatWindowDiagnostics } from "../ChatWindowDiagnostics"

const say = (ts: number, text = "text", kind: ClineMessage["say"] = "text"): ClineMessage => ({
	ts,
	type: "say",
	say: kind,
	text,
})
const task = (messages: ClineMessage[]) => ({
	taskId: "task",
	instanceId: "instance",
	clineMessages: messages,
	chatHistoryIndex: new ChatHistoryIndex(),
})

describe("bounded chat history", () => {
	it.each([20, 50, 100])("bounds a synthetic %i MiB hydration without mutating authoritative history", (mib) => {
		const messages = [
			say(0, "root"),
			...Array.from({ length: mib * 16 }, (_, i) => say(i + 1, "x".repeat(64 * 1024))),
		]
		const source = task(messages)
		const window = new ChatWindow()
		const result = window.snapshot(source)
		expect(result.chatWindow.byteLength).toBe(Buffer.byteLength(JSON.stringify(result)))
		expect(result.chatWindow.byteLength).toBeLessThanOrEqual(CHAT_WINDOW_BYTES)
		expect(result.clineMessages.length).toBeLessThanOrEqual(101)
		expect(result.clineMessages[0].text).toBe("root")
		expect(result.clineMessages.at(-1)?.ts).toBe(messages.at(-1)?.ts)
		expect(result.chatWindow.liveMessage?.ts).toBe(messages.at(-1)?.ts)
		expect(result.chatWindow.truncatedTs.length).toBeGreaterThan(0)
		expect(messages.at(-1)?.text?.length).toBe(64 * 1024)
		const processed = source.chatHistoryIndex.processedMessages
		window.snapshot(source)
		expect(source.chatHistoryIndex.processedMessages).toBe(processed)
	})

	it("preserves oversized pending authorization in full and bounds it once answered", () => {
		const ask: ClineMessage = {
			ts: 2,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ command: "x".repeat(2 * CHAT_WINDOW_BYTES) }),
			images: ["large-image"],
		}
		const source = task([say(0), ask])
		const window = new ChatWindow()
		const result = window.snapshot(source)
		expect(result.chatWindow.oversizedLiveAsk).toBe(true)
		expect(result.chatWindow.liveMessage).toMatchObject(ask)
		expect(result.clineMessages.at(-1)).toMatchObject(ask)
		expect(result.chatWindow.truncatedTs).not.toContain(ask.ts)
		ask.isAnswered = true
		source.chatHistoryIndex.update(source.clineMessages, ask)
		expect(window.snapshot(source).chatWindow.byteLength).toBeLessThan(CHAT_WINDOW_BYTES)
	})

	it("pages by exclusive indices, rejects stale identities, and returns to latest", () => {
		const source = task(Array.from({ length: 350 }, (_, i) => say(i)))
		const window = new ChatWindow()
		let state = window.snapshot(source).chatWindow
		const request = {
			taskId: source.taskId,
			instanceId: source.instanceId,
			revision: state.revision,
			before: state.startIndex,
		}
		expect(window.request(source, { ...request, instanceId: "stale" })).toBe(false)
		expect(window.request(source, request)).toBe(true)
		state = window.snapshot(source).chatWindow
		expect(state.endIndex).toBe(request.before)
		expect(state.following).toBe(false)
		expect(state.liveMessage).toBeUndefined()
		expect(state.hasNewer).toBe(true)
		expect(window.request(source, { ...request, revision: -1 })).toBe(true)
		expect(window.snapshot(source).chatWindow.reason).toBe("staleRevision")
		window.request(source, { ...request, latest: true })
		expect(window.snapshot(source).chatWindow.following).toBe(true)
	})

	it("bounds escaped text, images, reasoning and nested fields while preserving the tail", () => {
		const source = task([
			say(0, "\u0000".repeat(100_000)),
			{
				...say(1, "\u0000".repeat(100_000)),
				images: ["x".repeat(2_000_000)],
				checkpoint: { large: "y".repeat(2_000_000) },
				reasoning: "r".repeat(2_000_000),
			},
		])
		const result = new ChatWindow().snapshot(source)
		expect(result.chatWindow.byteLength).toBeLessThan(CHAT_WINDOW_BYTES)
		expect(result.clineMessages.at(-1)?.ts).toBe(1)
		expect(result.chatWindow.truncatedTs).toEqual([0, 1])
		expect(Buffer.byteLength(utf8Preview("€".repeat(100), 17))).toBeLessThanOrEqual(17)
		expect(utf8Preview("€".repeat(100), 17)).not.toContain("�")
	})
})

describe("incremental summary index", () => {
	it("matches legacy paired metrics, condensing and subsequent updates", () => {
		const messages: ClineMessage[] = [
			say(0),
			say(1, '{"tokensIn":10,"tokensOut":2,"cacheWrites":0}', "api_req_started"),
			say(2, '{"tokensIn":20,"cost":1}', "api_req_started"),
			say(3, '{"cost":2,"tokensOut":5}', "api_req_finished"),
			say(4, '{"cost":3}', "api_req_finished"),
			say(5, "{}", "api_req_started"),
		]
		const index = new ChatHistoryIndex().ensure(messages)
		const expected = () => consolidateTokenUsage(consolidateApiRequests(messages.slice(1)))
		expect(index.tokenUsage).toEqual(expected())
		messages[3].text = '{"tokensIn":30,"cost":8}'
		index.update(messages, messages[3])
		expect(index.tokenUsage).toEqual(expected())
		messages[1].text = '{"tokensIn":50,"cacheReads":4}'
		index.update(messages, messages[1])
		expect(index.tokenUsage).toEqual(expected())
		const condense: ClineMessage = {
			ts: 6,
			type: "say",
			say: "condense_context",
			contextCondense: {
				cost: 0.1,
				prevContextTokens: 100,
				newContextTokens: 9,
				summary: "summary",
				condenseId: "id",
			},
		}
		messages.push(condense)
		index.append(messages, condense)
		expect(index.tokenUsage).toEqual(expected())
		condense.contextCondense!.newContextTokens = 0
		index.update(messages, condense)
		expect(index.tokenUsage).toEqual(expected())
	})

	it("keeps same-timestamp usage contributions independent through updates and rebuilds", () => {
		const first = say(2, JSON.stringify({ tokensIn: 10, cost: 1 }), "api_req_started")
		const second = say(2, JSON.stringify({ tokensIn: 20, cost: 2 }), "api_req_started")
		const messages = [say(1), first, second]
		const index = new ChatHistoryIndex().ensure(messages)
		first.text = JSON.stringify({ tokensIn: 15, cost: 1.5 })
		index.update(messages, first)
		expect(index.tokenUsage).toMatchObject({ totalTokensIn: 35, totalCost: 3.5, contextTokens: 20 })
		second.text = JSON.stringify({ tokensIn: 25, cost: 2.5 })
		index.update(messages, second)
		expect(index.tokenUsage).toMatchObject({ totalTokensIn: 40, totalCost: 4, contextTokens: 25 })
		index.rebuild([...messages])
		expect(index.tokenUsage).toMatchObject({ totalTokensIn: 40, totalCost: 4, contextTokens: 25 })
	})
	it("pairs legacy finish records by row identity even when all timestamps collide", () => {
		const start = say(2, JSON.stringify({ tokensIn: 10 }), "api_req_started")
		const finish = say(2, JSON.stringify({ tokensIn: 20, cost: 1 }), "api_req_finished")
		const later = say(2, JSON.stringify({ tokensIn: 30, cost: 2 }), "api_req_started")
		const messages = [say(1), start, finish, later]
		const index = new ChatHistoryIndex().ensure(messages)
		finish.text = JSON.stringify({ tokensIn: 25, cost: 1.5 })
		index.update(messages, finish)
		expect(index.tokenUsage).toMatchObject({ totalTokensIn: 55, totalCost: 3.5, contextTokens: 30 })
	})
	it("keeps file summaries independent for same-timestamp edits", () => {
		const edit = (path: string, added: number) =>
			say(
				2,
				JSON.stringify({ tool: "appliedDiff", path, diff: "+line", diffStats: { added, removed: 0 } }),
				"tool",
			)
		const first = edit("a.ts", 1)
		const second = edit("b.ts", 2)
		const messages = [say(1), first, second]
		const index = new ChatHistoryIndex().ensure(messages)
		first.text = edit("a.ts", 3).text
		index.update(messages, first)
		expect(index.summary().files).toEqual([
			{ path: "b.ts", added: 2, removed: 0, changes: 1 },
			{ path: "a.ts", added: 3, removed: 0, changes: 1 },
		])
	})
	it("processes only appended/updated rows during streaming and resets on replacement", () => {
		const messages = Array.from({ length: 10000 }, (_, i) => say(i))
		const index = new ChatHistoryIndex().ensure(messages)
		const initial = index.processedMessages
		for (let i = 0; i < 100; i++) {
			messages.at(-1)!.text = `stream ${i}`
			index.update(messages, messages.at(-1)!)
			index.summary()
		}
		expect(index.processedMessages - initial).toBe(100)
		expect(index.rebuilds).toBe(1)
		messages.push(say(10000))
		index.append(messages, messages.at(-1)!)
		expect(index.processedMessages - initial).toBe(101)
		index.ensure([say(0)])
		expect(index.rebuilds).toBe(2)
		expect(index.tokenUsage.totalTokensIn).toBe(0)
	})

	it("counts only answered, non-partial file edits including batch diffs, without retaining bodies", () => {
		const edit: ClineMessage = {
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "appliedDiff",
				batchDiffs: [
					{ path: "a.ts", content: "private diff", diffStats: { added: 3, removed: 2 } },
					{ path: "b.ts", diffs: [{ content: "other diff" }] },
				],
			}),
		}
		const messages = [say(0), edit]
		const index = new ChatHistoryIndex().ensure(messages)
		expect(index.summary().files).toEqual([])
		edit.isAnswered = true
		index.update(messages, edit)
		expect(index.summary().files).toEqual([
			{ path: "a.ts", added: 3, removed: 2, changes: 1 },
			{ path: "b.ts", added: 0, removed: 0, changes: 1 },
		])
		expect(JSON.stringify(index.summary())).not.toContain("private diff")
		edit.partial = true
		index.update(messages, edit)
		expect(index.summary().files).toEqual([])
	})
})

describe("window acknowledgements", () => {
	it("logs metadata-only timeout once and clears pending timers", () => {
		vi.useFakeTimers()
		const log = vi.fn()
		const diagnostics = new ChatWindowDiagnostics(log)
		const state = new ChatWindow().snapshot(task([say(0, "SECRET")])).chatWindow
		diagnostics.sent(state)
		diagnostics.acknowledge({
			taskId: "wrong",
			instanceId: state.instanceId,
			sequence: state.sequence,
			phase: "rendered",
		})
		vi.advanceTimersByTime(10_001)
		expect(log).toHaveBeenCalledTimes(1)
		expect(log.mock.calls[0][0]).not.toContain("SECRET")
		diagnostics.dispose()
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
	})
})
