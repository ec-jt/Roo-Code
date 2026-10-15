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
		const request = {
			operationId: "op",
			taskId: "task",
			instanceId: "instance",
			ts: 2,
			index: 1,
			revision: revision(task),
		}
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
			chatMessageEdit: {
				operationId: "op",
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				index: 1,
				revision: revision(task),
			},
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
			chatMessageEdit: {
				operationId: "op",
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				index: 1,
				revision: revision(task) + 1,
			},
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({
			error: expect.stringContaining("History changed"),
		})

		postMessageToWebview.mockClear()
		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: {
				operationId: "op",
				taskId: "task",
				instanceId: "instance",
				ts: 3,
				index: 2,
				revision: revision(task),
			},
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({ error: expect.stringContaining("your own") })

		postMessageToWebview.mockClear()
		await provider.handleChatWindowMessage({
			type: "chatMessageEdit",
			chatMessageEdit: {
				operationId: "op",
				taskId: "other",
				instanceId: "instance",
				ts: 2,
				index: 1,
				revision: revision(task),
			},
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
			chatMessageEdit: {
				operationId: "op",
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				index: 1,
				revision: rev,
			},
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
			chatMessageEdit: {
				operationId: "op",
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				index: 1,
				revision: revision(task),
			},
		})
		expect(reply(postMessageToWebview.mock.calls)).toMatchObject({ tooLarge: true })
	})
})

describe("user edit confirmation fencing", () => {
	const setup = () => {
		const value = harness()
		const task = Object.assign(value.task, {
			assertUserEditReady: vi.fn(),
			editUserMessage: vi.fn().mockResolvedValue(undefined),
		})
		Object.assign(value.provider, { postStateToWebview: vi.fn().mockResolvedValue(undefined) })
		const identity = {
			operationId: "save",
			taskId: "task",
			instanceId: "instance",
			ts: 2,
			index: 1,
			revision: revision(task),
		}
		return { ...value, task, identity }
	}
	it.each(["submitEditedMessage", "editMessageConfirm"] as const)("rejects missing identity on %s", async (type) => {
		const { provider, task } = setup()
		await webviewMessageHandler(provider, {
			type,
			value: 2,
			messageTs: 2,
			text: "new",
			editedMessageContent: "new",
		})
		expect(task.editUserMessage).not.toHaveBeenCalled()
	})
	it("checks readiness before opening a confirmation", async () => {
		const { provider, task, identity, postMessageToWebview } = setup()
		task.assertUserEditReady.mockImplementation(() => {
			throw new Error("request active")
		})
		await provider.handleUserMessageEdit({
			type: "submitEditedMessage",
			value: 2,
			editedMessageContent: "new",
			chatMessageEdit: identity,
		})
		expect(postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				chatMessageEditResult: expect.objectContaining({ status: "error", error: "request active" }),
			}),
		)
		expect(task.editUserMessage).not.toHaveBeenCalled()
	})
	it.each(["cancel", "checkpoint", "switched", "revision", "expired"])(
		"does not commit %s confirmations",
		async (kind) => {
			const { provider, task, identity, postMessageToWebview } = setup()
			await provider.handleUserMessageEdit({
				type: "submitEditedMessage",
				value: 2,
				editedMessageContent: "new",
				chatMessageEdit: identity,
			})
			if (kind === "switched") task.instanceId = "other"
			if (kind === "revision") task.clineMessages.push({ ts: 4, type: "say", say: "text", text: "changed" })
			if (kind === "expired") (provider as any).pendingUserEdit.expires = 0
			await provider.handleUserMessageEdit({
				type: kind === "cancel" ? "editMessageCancel" : "editMessageConfirm",
				restoreCheckpoint: kind === "checkpoint",
				chatMessageEdit: identity,
			})
			expect(task.editUserMessage).not.toHaveBeenCalled()
			expect(postMessageToWebview).toHaveBeenLastCalledWith(
				expect.objectContaining({
					chatMessageEditResult: expect.objectContaining({
						status: kind === "cancel" ? "cancelled" : "error",
					}),
				}),
			)
		},
	)
	it("uses the stored draft, consumes confirmation once and reports success", async () => {
		const { provider, task, identity, postMessageToWebview } = setup()
		await provider.handleUserMessageEdit({
			type: "submitEditedMessage",
			value: 2,
			editedMessageContent: "full draft",
			images: [IMAGE],
			chatMessageEdit: identity,
		})
		await provider.handleUserMessageEdit({
			type: "editMessageConfirm",
			text: "tampered",
			chatMessageEdit: identity,
		})
		expect(task.editUserMessage).toHaveBeenCalledWith(identity, "full draft", [IMAGE])
		expect(postMessageToWebview).toHaveBeenLastCalledWith(
			expect.objectContaining({ chatMessageEditResult: expect.objectContaining({ status: "success" }) }),
		)
		await provider.handleUserMessageEdit({ type: "editMessageConfirm", chatMessageEdit: identity })
		expect(task.editUserMessage).toHaveBeenCalledTimes(1)
	})
})
