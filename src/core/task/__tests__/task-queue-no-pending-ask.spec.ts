import { Task } from "../Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"

// A user message that reaches the extension while no ask is waiting must not be
// stored in the ask response slot, where the next ask's reset would wipe it.
// It is queued instead, and the next ask drains it as feedback.

function makeTask(state?: Record<string, unknown>) {
	const task = Object.create(Task.prototype) as Task
	;(task as any).abort = false
	;(task as any).modelOperationAdmission = { requiresApproval: false }
	;(task as any).clineMessages = []
	;(task as any).askResponse = undefined
	;(task as any).askResponseText = undefined
	;(task as any).askResponseImages = undefined
	;(task as any).lastMessageTs = undefined
	;(task as any).pendingAskCount = 0
	;(task as any).messageQueueService = new MessageQueueService()
	;(task as any).addToClineMessages = vi.fn(async (message: any) => {
		;(task as any).clineMessages.push(message)
	})
	;(task as any).saveClineMessages = vi.fn(async () => {})
	;(task as any).updateClineMessage = vi.fn(async () => {})
	;(task as any).checkpointSave = vi.fn(async () => {})
	;(task as any).emit = vi.fn()
	;(task as any).providerRef = { deref: () => (state ? { getState: async () => state } : undefined) }
	return task
}

describe("Task message sent while no ask is pending", () => {
	it("queues messageResponse text instead of storing it", () => {
		const task = makeTask()

		expect(task.isAskPending).toBe(false)
		task.handleWebviewAskResponse("messageResponse", "hello", ["img"])

		expect((task as any).askResponse).toBeUndefined()
		expect((task as any).askResponseText).toBeUndefined()
		expect(task.messageQueueService.messages).toHaveLength(1)
		expect(task.messageQueueService.messages[0]).toMatchObject({ text: "hello", images: ["img"] })
	})

	it("delivers the queued text with the next auto-approved tool ask", async () => {
		const task = makeTask({ autoApprovalEnabled: true, alwaysAllowReadOnly: true })

		task.handleWebviewAskResponse("messageResponse", "hello")
		const result = await task.ask("tool", JSON.stringify({ tool: "readFile", path: "a.ts" }), false)

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBe("hello")
		expect(task.messageQueueService.isEmpty()).toBe(true)
		expect(task.isAskPending).toBe(false)
	})

	it("delivers the queued text with the next tool ask that the user answers", async () => {
		const task = makeTask()

		task.handleWebviewAskResponse("messageResponse", "hello")
		const result = await task.ask("tool", JSON.stringify({ tool: "editedExistingFile" }), false)

		expect(result).toEqual({ response: "yesButtonClicked", text: "hello", images: undefined })
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("still delivers a response directly to a waiting ask", async () => {
		const task = makeTask()

		const pending = task.ask("followup", "Q?", false)
		await vi.waitFor(() => expect(task.isAskPending).toBe(true))
		await vi.waitFor(() => expect((task as any).addToClineMessages).toHaveBeenCalledOnce())
		task.handleWebviewAskResponse("messageResponse", "answer", ["img"])

		expect(task.messageQueueService.isEmpty()).toBe(true)
		expect(await pending).toEqual({ response: "messageResponse", text: "answer", images: ["img"] })
		expect(task.isAskPending).toBe(false)
	})

	it("does not queue button responses or empty messages", () => {
		const task = makeTask()

		task.handleWebviewAskResponse("yesButtonClicked", "approve text")
		expect((task as any).askResponse).toBe("yesButtonClicked")
		;(task as any).askResponse = undefined

		task.handleWebviewAskResponse("noButtonClicked")
		expect((task as any).askResponse).toBe("noButtonClicked")
		;(task as any).askResponse = undefined

		task.handleWebviewAskResponse("messageResponse", "   ")
		expect(task.messageQueueService.isEmpty()).toBe(true)
	})

	it("partial asks do not mark an ask as pending", async () => {
		const task = makeTask()

		await expect(task.ask("tool", "{}", true)).rejects.toThrow()
		expect(task.isAskPending).toBe(false)
	})
})
