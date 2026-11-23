import { Task } from "../Task"

// Keep this test focused: if a queued message arrives while Task.ask() is blocked,
// it should be consumed and used to fulfill the ask.

describe("Task.ask queued message drain", () => {
	it("consumes queued message while blocked on followup ask", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).modelOperationAdmission = { requiresApproval: false }
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		// Message queue service exists in constructor; for unit test we can attach a real one.
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()

		// Minimal stubs used by ask()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("followup", "Q?", false)

		// Simulate webview queuing the user's selection text while the ask is pending.
		;(task as any).messageQueueService.addMessage("picked answer")

		const result = await askPromise
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("picked answer")
	})

	it("does not consume queued messages for command_output asks", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).modelOperationAdmission = { requiresApproval: false }
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("command_output", "command is still running...", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})
	it("does not consume queued messages as mandatory branch tool approval", async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).modelOperationAdmission = { requiresApproval: true }
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined

		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async () => {})
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }

		const askPromise = task.ask("tool", "new effect", false)
		;(task as any).messageQueueService.addMessage("1+1=?")

		setTimeout(() => {
			task.approveAsk()
		}, 0)

		const result = await askPromise

		expect(result.response).toBe("yesButtonClicked")
		expect(result.text).toBeUndefined()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		expect((task as any).messageQueueService.messages[0]?.text).toBe("1+1=?")
	})

	const makeTask = async () => {
		const task = Object.create(Task.prototype) as Task
		;(task as any).abort = false
		;(task as any).modelOperationAdmission = { requiresApproval: false }
		;(task as any).clineMessages = []
		;(task as any).askResponse = undefined
		;(task as any).askResponseText = undefined
		;(task as any).askResponseImages = undefined
		;(task as any).lastMessageTs = undefined
		const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
		;(task as any).messageQueueService = new MessageQueueService()
		;(task as any).addToClineMessages = vi.fn(async (message: any) => (task as any).clineMessages.push(message))
		;(task as any).saveClineMessages = vi.fn(async () => {})
		;(task as any).updateClineMessage = vi.fn(async () => {})
		;(task as any).cancelAutoApprovalTimeout = vi.fn(() => {})
		;(task as any).checkpointSave = vi.fn(async () => {})
		;(task as any).emit = vi.fn()
		;(task as any).providerRef = { deref: () => undefined }
		return task
	}

	it.each(["tool", "command", "use_mcp_server", "browser_action_launch"] as const)(
		"L1 defect 6: a queued message does not answer an open %s approval; it follows the user's decision",
		async (type) => {
			const task = await makeTask()
			const askPromise = task.ask(type, "{}", false)
			;(task as any).messageQueueService.addMessage("drift: rewrite stored data")
			// The queue is not drained while the approval is open.
			await new Promise((resolve) => setTimeout(resolve, 250))
			expect((task as any).askResponse).toBeUndefined()
			expect((task as any).messageQueueService.isEmpty()).toBe(false)
			// The user clicks Approve; the held message is delivered as feedback after the decision.
			task.approveAsk()
			const result = await askPromise
			expect(result.response).toBe("yesButtonClicked")
			expect(result.text).toBe("drift: rewrite stored data")
			expect((task as any).messageQueueService.isEmpty()).toBe(true)
		},
	)

	it("L1 defect 6: a rejected approval keeps the decision and still delivers the held message", async () => {
		const task = await makeTask()
		const askPromise = task.ask("tool", "{}", false)
		;(task as any).messageQueueService.addMessage("why?")
		await new Promise((resolve) => setTimeout(resolve, 150))
		task.denyAsk()
		const result = await askPromise
		expect(result.response).toBe("noButtonClicked")
		expect(result.text).toBe("why?")
	})

	it("L1 defect 6: processQueuedMessages does not submit while a tool approval is open", async () => {
		const task = await makeTask()
		;(task as any).pendingAskCount = 1
		;(task as any).clineMessages = [{ type: "ask", ask: "tool", ts: 1 }]
		;(task as any).messageQueueService.addMessage("held")
		const submit = vi.spyOn(task, "submitUserMessage").mockResolvedValue(undefined)
		task.processQueuedMessages()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(submit).not.toHaveBeenCalled()
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
		// A free-text ask still drains the queue.
		;(task as any).clineMessages = [{ type: "ask", ask: "followup", ts: 2 }]
		task.processQueuedMessages()
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(submit).toHaveBeenCalledOnce()
		expect(submit.mock.calls[0][0]).toBe("held")
	})
})
