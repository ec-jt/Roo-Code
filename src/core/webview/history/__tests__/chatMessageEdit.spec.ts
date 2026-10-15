import * as vscode from "vscode"
import type { ClineMessage, ExtensionMessage } from "@roo-code/types"
import { ChatWindow } from "../ChatWindow"
import { ChatHistoryIndex } from "../ChatHistoryIndex"
import { ClineProvider } from "../../ClineProvider"
import { webviewMessageHandler } from "../../webviewMessageHandler"
import { isChatPreview } from "../../../../shared/chat-preview"

const FULL_TEXT = "prefix text " + "x".repeat(40_000)
const IMAGE = "data:image/png;base64," + "A".repeat(200_000)

const source = () => ({
	taskId: "task",
	instanceId: "instance",
	chatHistoryIndex: new ChatHistoryIndex(),
	clineMessages: [
		{ ts: 1, type: "say", say: "text", text: "task" },
		{ ts: 2, type: "say", say: "user_feedback", text: FULL_TEXT, images: [IMAGE] },
		{ ts: 3, type: "ask", ask: "tool", text: '{"tool":"readFile"}' },
	] as ClineMessage[],
})

type Task = ReturnType<typeof source>

const harness = (chatWindow = new ChatWindow()) => {
	const task = source()
	const postMessageToWebview = vi.fn(async (_message: ExtensionMessage) => {})
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		getCurrentTask: () => task,
		chatWindow,
		postMessageToWebview,
	}) as ClineProvider & { postMessageToWebview: typeof postMessageToWebview }
	return { task, provider, postMessageToWebview }
}

const reply = (calls: unknown[][]) =>
	(calls.at(-1)?.[0] as { type: string; chatMessageEditData?: Record<string, unknown> })?.chatMessageEditData

const revision = (task: Task) => task.chatHistoryIndex.ensure(task.clineMessages).revision

describe("correlated user-message edit retrieval", () => {
	it("validates the original row identity for save and rejects changed revisions and duplicate timestamps", () => {
		const { task, provider } = harness()
		const request = { taskId: "task", instanceId: "instance", ts: 2, index: 1, revision: revision(task) }
		expect(provider.validateChatMessageEdit(request)).toBe(true)
		expect(provider.validateChatMessageEdit({ ...request, revision: request.revision + 1 })).toBe(false)
		task.clineMessages.push({ ts: 2, type: "say", say: "user_feedback", text: "different row" })
		expect(provider.validateChatMessageEdit({ ...request, revision: revision(task) })).toBe(false)
	})
	it("returns the full stored text and attachments, never the truncated preview prefix", async () => {
		const { task, provider, postMessageToWebview } = harness()
		const snapshot = new ChatWindow().snapshot(task)
		const previewRow = snapshot.clineMessages.find((row) => row.ts === 2)!
		// The bounded snapshot only carries a prefix and drops the oversized attachment.
		expect(isChatPreview(previewRow, snapshot.chatWindow)).toBe(true)
		expect(previewRow.text).not.toBe(task.clineMessages[1].text)

		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 2, index: 1, revision: revision(task) },
		})
		expect(postMessageToWebview).toHaveBeenCalledTimes(1)
		expect(postMessageToWebview.mock.calls[0][0]).toMatchObject({
			type: "chatMessageEditData",
			chatMessageEditData: {
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				index: 1,
				text: task.clineMessages[1].text,
				images: [IMAGE],
			},
		})
	})

	it("rejects stale revisions, non-user rows, and identity mismatches", async () => {
		const { task, provider, postMessageToWebview } = harness()
		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 2, index: 1, revision: revision(task) + 1 },
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({
			error: expect.stringContaining("History changed"),
		})

		postMessageToWebview.mockClear()
		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 3, index: 2, revision: revision(task) },
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({ error: expect.stringContaining("your own") })

		postMessageToWebview.mockClear()
		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "other", instanceId: "instance", ts: 2, index: 1, revision: revision(task) },
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({
			error: expect.stringContaining("instance changed"),
		})
	})

	it("refuses retrieval while browsing a historical page", async () => {
		const chatWindow = new ChatWindow()
		const { task, provider, postMessageToWebview } = harness(chatWindow)
		const rev = revision(task)
		expect(chatWindow.request(task, { taskId: "task", instanceId: "instance", revision: rev, before: 2 })).toBe(
			true,
		)

		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 2, index: 1, revision: rev },
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({
			error: expect.stringContaining("latest page"),
		})
	})

	it("reports oversized attachments as too large instead of dropping them", async () => {
		const task = source()
		task.clineMessages[1] = {
			ts: 2,
			type: "say",
			say: "user_feedback",
			text: "small",
			images: ["A".repeat(1_100_000)],
		}
		const postMessageToWebview = vi.fn(async () => {})
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			getCurrentTask: () => task,
			chatWindow: new ChatWindow(),
			postMessageToWebview,
		}) as ClineProvider

		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 2, index: 1, revision: revision(task) },
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({ tooLarge: true })
	})
})

describe("submitEditedMessage task fencing", () => {
	it.each(["submitEditedMessage", "editMessageConfirm"] as const)(
		"rejects stale correlated %s before confirmation or history writes",
		async (type) => {
			const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
			const provider = {
				getCurrentTask: () => ({ taskId: "task", instanceId: "instance" }),
				validateChatMessageEdit: vi.fn(() => false),
				postMessageToWebview: vi.fn(),
			}
			await webviewMessageHandler(provider as never, {
				type,
				value: 2,
				messageTs: 2,
				editedMessageContent: "changed",
				text: "changed",
				chatMessageEdit: { taskId: "task", instanceId: "old", ts: 2, index: 1, revision: 8 },
			})
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(warn).toHaveBeenCalled()
			warn.mockRestore()
		},
	)
	it("refuses an edit correlated to a task the user has switched away from", async () => {
		const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
		const provider = {
			getCurrentTask: () => ({ taskId: "task", instanceId: "instance" }),
			postMessageToWebview: vi.fn(),
		}
		await webviewMessageHandler(provider as never, {
			type: "submitEditedMessage",
			value: 5,
			editedMessageContent: "changed",
			taskId: "other",
			instanceId: "instance",
		})
		expect(warn).toHaveBeenCalledWith("This edit no longer applies to the current task.")
		warn.mockRestore()
	})
})
