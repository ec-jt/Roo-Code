import * as vscode from "vscode"
import type { ClineMessage } from "@roo-code/types"
import { ChatWindow } from "../ChatWindow"
import { ChatHistoryIndex } from "../ChatHistoryIndex"
import { ClineProvider } from "../../ClineProvider"
import { isChatPreview } from "../../../../shared/chat-preview"

describe("history preview identity and empty content", () => {
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
