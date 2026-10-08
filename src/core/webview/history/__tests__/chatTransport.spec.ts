import type { ClineMessage, ExtensionMessage } from "@roo-code/types"
import { ClineProvider } from "../../ClineProvider"
import { ChatHistoryIndex } from "../ChatHistoryIndex"
import { ChatWindow, CHAT_WINDOW_BYTES } from "../ChatWindow"
import { ChatWindowDiagnostics } from "../ChatWindowDiagnostics"

function fixture() {
	const messages: ClineMessage[] = Array.from({ length: 500 }, (_, ts) => ({
		ts,
		type: "say",
		say: "text",
		text: "x".repeat(64 * 1024),
	}))
	const task = {
		taskId: "task",
		instanceId: "instance",
		clineMessages: messages,
		chatHistoryIndex: new ChatHistoryIndex(),
		todoList: [{ id: "todo-1", content: "Live todo", status: "pending" }],
	}
	const postMessage = vi.fn().mockResolvedValue(true)
	const provider = Object.create(ClineProvider.prototype) as ClineProvider
	Object.assign(provider, {
		chatWindow: new ChatWindow(),
		chatWindowDiagnostics: new ChatWindowDiagnostics(vi.fn()),
		clineMessagesSeq: 0,
		lastChatWindowPost: 0,
		view: { webview: { postMessage } },
		_runningTaskMonitor: { syncApproval: vi.fn(), value: undefined },
		getCommandActivities: () => [],
		getCurrentTask: () => task,
	})
	return { provider, task, postMessage, dispose: () => (provider as any).chatWindowDiagnostics.dispose() }
}

describe("bounded provider transport", () => {
	it("replaces full-history state and raw messageUpdated at the final send boundary", async () => {
		const { provider, task, postMessage, dispose } = fixture()
		await provider.postMessageToWebview({ type: "state", state: { clineMessages: task.clineMessages } })
		await provider.postMessageToWebview({ type: "messageUpdated", clineMessage: task.clineMessages.at(-1)! })
		for (const [message] of postMessage.mock.calls as [ExtensionMessage][]) {
			expect(message.type).toBe("state")
			expect(message.clineMessage).toBeUndefined()
			expect(message.state?.clineMessages?.length).toBeLessThanOrEqual(101)
			expect(message.state?.chatWindow?.byteLength).toBeLessThanOrEqual(CHAT_WINDOW_BYTES)
			expect(message.state?.currentTaskTodos).toEqual(task.todoList)
		}
		expect(postMessage.mock.calls[1][0].state.chatWindow.sequence).toBeGreaterThan(
			postMessage.mock.calls[0][0].state.chatWindow.sequence,
		)
		dispose()
	})

	it("coalesces partial text but sends a complete ask immediately", async () => {
		vi.useFakeTimers()
		const { provider, task, postMessage, dispose } = fixture()
		await provider.postMessageToWebview({ type: "state", state: { clineMessages: task.clineMessages } })
		const last = task.clineMessages.at(-1)!
		last.partial = true
		for (let i = 0; i < 10; i++) await provider.postMessageToWebview({ type: "messageUpdated", clineMessage: last })
		expect(postMessage).toHaveBeenCalledTimes(1)
		const ask: ClineMessage = { ts: 501, type: "ask", ask: "command", text: "permission payload" }
		task.clineMessages.push(ask)
		task.chatHistoryIndex.append(task.clineMessages, ask)
		await provider.postMessageToWebview({ type: "messageUpdated", clineMessage: ask })
		expect(postMessage).toHaveBeenCalledTimes(2)
		expect(postMessage.mock.calls[1][0].state.chatWindow.liveMessage).toEqual(ask)
		dispose()
		vi.useRealTimers()
	})
})
