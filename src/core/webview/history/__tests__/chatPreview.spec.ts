import * as vscode from "vscode"
import type { ClineMessage } from "@roo-code/types"
import { ChatWindow, CHAT_PREVIEW_BYTES, CHAT_EDITOR_BYTES, CHAT_WINDOW_BYTES } from "../ChatWindow"
import { ChatHistoryIndex } from "../ChatHistoryIndex"
import { ClineProvider } from "../../ClineProvider"
import { isChatPreview } from "../../../../shared/chat-preview"

describe("history preview identity and empty content", () => {
	it.each(["summary text", 'summary\n"'.repeat(10_000)])(
		"keeps structured summary previews bounded and opens the full stored summary",
		async (summary) => {
			const task = source()
			task.clineMessages = [
				task.clineMessages[0],
				{
					ts: 3,
					type: "say",
					say: "condense_context",
					contextCondense: {
						summary,
						condenseId: "event-1",
						cost: 0,
						prevContextTokens: 1000,
						newContextTokens: 100,
					},
				},
			]
			const before = structuredClone(task.clineMessages)
			const result = new ChatWindow().snapshot(task)
			const row = result.clineMessages[1]
			expect(row.contextCondense?.summary).toBeTruthy()
			expect(row.contextCondense?.condenseId).toBe("event-1")
			expect(row.chatPreview).toMatchObject({ label: "Context summary", hasContent: true })
			expect(row.chatPreview?.truncated).toBe(summary.length > CHAT_PREVIEW_BYTES / 6)
			expect(Buffer.byteLength(JSON.stringify(row.contextCondense))).toBeLessThan(CHAT_PREVIEW_BYTES)
			expect(result.chatWindow.byteLength).toBeLessThan(CHAT_WINDOW_BYTES)
			expect(task.clineMessages).toEqual(before)
			const open = vi.fn()
			const provider = Object.assign(Object.create(ClineProvider.prototype), {
				getCurrentTask: () => task,
				chatHistoryDocument: { open },
			})
			await provider.handleChatWindowMessage({
				type: "chatMessageOpen",
				chatMessageOpen: {
					taskId: "task",
					instanceId: "instance",
					ts: 3,
					index: 1,
					revision: result.chatWindow.revision,
				},
			})
			expect(open).toHaveBeenCalledWith(summary, expect.any(Function))
		},
	)
	it("refuses summaries above the native editor bound", async () => {
		const task = source()
		task.clineMessages.push({
			ts: 3,
			type: "say",
			say: "condense_context",
			contextCondense: {
				summary: "x".repeat(CHAT_EDITOR_BYTES + 1),
				cost: 0,
				prevContextTokens: 100,
				newContextTokens: 10,
			},
		})
		const open = vi.fn()
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			getCurrentTask: () => task,
			chatHistoryDocument: { open },
		})
		await provider.handleChatWindowMessage({
			type: "chatMessageOpen",
			chatMessageOpen: { taskId: "task", instanceId: "instance", ts: 3 },
		})
		expect(open).not.toHaveBeenCalled()
	})
	const source = () => ({
		taskId: "task",
		instanceId: "instance",
		chatHistoryIndex: new ChatHistoryIndex(),
		clineMessages: [
			{ ts: 1, type: "say", say: "text", text: "task" },
			{ ts: 2, type: "ask", ask: "command_output", text: "" },
			{
				ts: 2,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "readFile", content: "x".repeat(20_000) }),
			},
		] as ClineMessage[],
	})
	it("does not transfer truncation to an empty row with the same timestamp", () => {
		const result = new ChatWindow().snapshot(source())
		expect(isChatPreview(result.clineMessages[1], result.chatWindow)).toBe(false)
		expect(isChatPreview(result.clineMessages[2], result.chatWindow)).toBe(true)
		expect(result.clineMessages[2].chatPreview).toMatchObject({ index: 2, label: "readFile", hasContent: true })
	})
	it("opens the indexed message, not the first timestamp match, and refuses empty or stale entries", async () => {
		const notification = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
		const task = source()
		const result = new ChatWindow().snapshot(task)
		const open = vi.fn()
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			getCurrentTask: () => task,
			chatHistoryDocument: { open },
		})
		const request = {
			taskId: task.taskId,
			instanceId: task.instanceId,
			ts: 2,
			index: 2,
			revision: result.chatWindow.revision,
		}
		await provider.handleChatWindowMessage({ type: "chatMessageOpen", chatMessageOpen: request })
		expect(open).toHaveBeenCalledWith(task.clineMessages[2].text, expect.any(Function))
		open.mockClear()
		await provider.handleChatWindowMessage({ type: "chatMessageOpen", chatMessageOpen: { ...request, index: 1 } })
		await provider.handleChatWindowMessage({
			type: "chatMessageOpen",
			chatMessageOpen: { ...request, revision: -1 },
		})
		await provider.handleChatWindowMessage({
			type: "chatMessageOpen",
			chatMessageOpen: { taskId: "task", instanceId: "instance", ts: 2 },
		})
		expect(open).not.toHaveBeenCalled()
		expect(notification).toHaveBeenCalled()
		notification.mockRestore()
	})
})
