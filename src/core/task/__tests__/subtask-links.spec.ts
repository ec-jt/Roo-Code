import type { ClineMessage, HistoryItem } from "@roo-code/types"
import { recoverSubtaskLinks } from "../subtask-links"
import { ChatWindow } from "../../webview/history/ChatWindow"

const ask = (ts: number, content: string, extra: Partial<ClineMessage> = {}): ClineMessage => ({
	ts,
	type: "ask",
	ask: "tool",
	text: JSON.stringify({ tool: "newTask", content }),
	isAnswered: true,
	...extra,
})
const child = (id: string, task: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	task,
	ts: 100,
	number: 1,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	parentTaskId: "parent",
	status: "completed",
	...extra,
})
const result = (ts: number): ClineMessage => ({ ts, type: "say", say: "subtask_result", text: "Done" })

describe("durable subtask links", () => {
	it("recovers the correct children despite a denied creation and deleted child", () => {
		const messages = [ask(1, "denied"), ask(2, "removed"), ask(3, "first"), result(4), ask(5, "latest")]
		const history = [child("first-id", "first"), child("latest-id", "latest", { status: "active" })]
		const recovered = recoverSubtaskLinks(messages, "parent", history)
		expect(recovered.map((row) => row.subtaskId)).toEqual([
			undefined,
			undefined,
			"first-id",
			"first-id",
			"latest-id",
		])
		expect(messages.every((row) => row.subtaskId === undefined)).toBe(true)
		expect(history[1].status).toBe("active")
	})

	it("keeps the latest child identity across a bounded page containing just one creation", () => {
		const messages = [
			ask(1, "first"),
			...Array.from(
				{ length: 120 },
				(_, i): ClineMessage => ({
					ts: i + 2,
					type: "say",
					say: "text",
					text: "progress",
				}),
			),
			ask(123, "latest"),
			{ ts: 124, type: "ask", ask: "resume_task" } as ClineMessage,
		]
		const source = recoverSubtaskLinks(messages, "parent", [
			child("first-id", "first"),
			child("latest-id", "latest", { status: "active" }),
		])
		const snapshot = new ChatWindow().snapshot({ taskId: "parent", instanceId: "instance", clineMessages: source })
		expect(snapshot.chatWindow.hasOlder).toBe(true)
		expect(snapshot.clineMessages.find((row) => row.ts === 123)?.subtaskId).toBe("latest-id")
	})

	it("preserves explicit IDs through truncated and escaped previews", () => {
		for (const content of ["x".repeat(100_000), "\u0000".repeat(100_000)]) {
			const source = [ask(1, "root"), ask(2, content, { subtaskId: "actual-child" }), result(3)]
			const snapshot = new ChatWindow().snapshot({
				taskId: "parent",
				instanceId: "instance",
				clineMessages: source,
			})
			expect(snapshot.clineMessages[1].chatPreview?.truncated).toBe(true)
			expect(snapshot.clineMessages[1].subtaskId).toBe("actual-child")
		}
	})

	it("links each historical result to its own creation, not the last completed child", () => {
		const messages = [ask(1, "first"), result(2), ask(3, "second"), result(4)]
		expect(
			recoverSubtaskLinks(messages, "parent", [child("one", "first"), child("two", "second")]).map(
				(row) => row.subtaskId,
			),
		).toEqual(["one", "one", "two", "two"])
	})

	it("does not guess when prompts repeat, belong to another parent, or are pending", () => {
		const messages = [
			ask(1, "repeat"),
			ask(2, "repeat"),
			ask(3, "duplicate children"),
			ask(4, "foreign"),
			ask(5, "pending", { isAnswered: false }),
		]
		const history = [
			child("one", "repeat"),
			child("two", "duplicate children"),
			child("three", "duplicate children"),
			child("four", "foreign", { parentTaskId: "other" }),
			child("five", "pending"),
		]
		expect(recoverSubtaskLinks(messages, "parent", history).every((row) => row.subtaskId === undefined)).toBe(true)
	})

	it("preserves explicit identity even for duplicate prompts and absent history", () => {
		const messages = [
			ask(1, "repeat", { subtaskId: "one" }),
			ask(2, "repeat", { subtaskId: "two" }),
			{ ...result(3), subtaskId: "two" },
		]
		expect(recoverSubtaskLinks(messages, "parent", []).map((row) => row.subtaskId)).toEqual(["one", "two", "two"])
	})

	it("handles new_task escaping and ignores malformed and partial tool JSON", () => {
		const messages = [
			ask(1, String.raw`Read \\@file`),
			{ ...ask(2, "partial"), partial: true },
			{ ...ask(3, "broken"), text: "{" },
		]
		const recovered = recoverSubtaskLinks(messages, "parent", [
			child("one", String.raw`Read \@file`),
			child("two", "partial"),
		])
		expect(recovered.map((row) => row.subtaskId)).toEqual(["one", undefined, undefined])
	})
})
