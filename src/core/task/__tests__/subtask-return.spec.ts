import type { ClineMessage, HistoryItem } from "@roo-code/types"
import type { ApiMessage } from "../../task-persistence"
import { canRecoverSubtaskReturn } from "../subtask-return"

function fixture() {
	const parent = {
		id: "parent",
		status: "active",
		delegatedToId: "child",
		childIds: ["older", "child"],
		completedByChildId: "older",
	} as HistoryItem
	const child = { id: "child", parentTaskId: "parent", status: "active", task: "Child task" } as HistoryItem
	const messages: ClineMessage[] = [
		{
			ts: 1,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "newTask", content: "Child task" }),
			subtaskId: "child",
			isAnswered: true,
		},
		{ ts: 2, type: "ask", ask: "resume_task" },
	]
	const api: ApiMessage[] = [
		{
			role: "assistant",
			content: [{ type: "tool_use", id: "call-child", name: "new_task", input: { message: "Child task" } }],
		},
	]
	return { parent, child, messages, api, recover: () => canRecoverSubtaskReturn(parent, child, messages, api) }
}

describe("recovering a viewed parent's pending return", () => {
	it("requires matching child identity and an unanswered final delegation in both histories", () => {
		const f = fixture()
		const before = structuredClone([f.parent, f.child, f.messages, f.api])
		expect(f.recover()).toBe(true)
		expect([f.parent, f.child, f.messages, f.api]).toEqual(before)
	})

	it.each([
		{ status: "completed" },
		{ awaitingChildId: "other" },
		{ delegatedToId: "other" },
		{ delegatedToId: undefined },
		{ childIds: ["child", "newer"] },
		{ childIds: [] },
		{ completedByChildId: "child" },
	] as Partial<HistoryItem>[])("rejects changed parent metadata: %j", (change) => {
		const f = fixture()
		Object.assign(f.parent, change)
		expect(f.recover()).toBe(false)
	})

	it.each([
		{ parentTaskId: "other" },
		{ status: "completed" },
		{ status: "delegated" },
		{ awaitingChildId: "grandchild" },
		{ task: "Different task" },
	] as Partial<HistoryItem>[])("rejects changed child metadata: %j", (change) => {
		const f = fixture()
		Object.assign(f.child, change)
		expect(f.recover()).toBe(false)
	})

	it.each([
		{ subtaskId: undefined },
		{ subtaskId: "other" },
		{ partial: true },
		{ isAnswered: false },
		{ text: "{" },
		{ text: JSON.stringify({ tool: "newTask", content: "Different task" }) },
	])("rejects an unverified creation card: %j", (change) => {
		const f = fixture()
		Object.assign(f.messages[0], change)
		expect(f.recover()).toBe(false)
	})

	it.each(["user_feedback", "subtask_result", "text"] as const)("rejects later %s in UI history", (say) => {
		const f = fixture()
		f.messages.push({ ts: 3, type: "say", say, text: "Parent advanced" })
		expect(f.recover()).toBe(false)
	})

	it.each(["user", "assistant"] as const)("rejects later %s messages in API history", (role) => {
		const f = fixture()
		f.api.push({ role, content: "Parent advanced" })
		expect(f.recover()).toBe(false)
	})

	it("rejects another tool or a changed native delegation prompt", () => {
		const f = fixture()
		const content = f.api[0].content as { name: string; input: { message: string } }[]
		content[0].input.message = "Different task"
		expect(f.recover()).toBe(false)
		content[0].input.message = "Child task"
		content[0].name = "other_tool"
		expect(f.recover()).toBe(false)
	})

	it("normalizes new_task escaping consistently with child creation", () => {
		const f = fixture()
		f.child.task = String.raw`Read \@file`
		f.messages[0].text = JSON.stringify({ tool: "newTask", content: String.raw`Read \\@file` })
		;(f.api[0].content as { input: { message: string } }[])[0].input.message = String.raw`Read \\@file`
		expect(f.recover()).toBe(true)
	})
})
