import { Task } from "../Task"
import { AskIgnoredError } from "../AskIgnoredError"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { readFileTool } from "../../tools/ReadFileTool"
import { isAuthorizationAsk } from "../../tool-execution/approval"
import { clineAsks } from "@roo-code/types"

describe("Task approval port", () => {
	let task: Task
	let check: ReturnType<typeof vi.fn>
	let state: any

	beforeEach(() => {
		check = vi.fn(async () => ({ decision: "continue" }))
		state = { autoApprovalEnabled: true, alwaysAllowAll: true }
		task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			instanceId: "instance",
			abort: false,
			modelOperationClosed: false,
			modelOperationRevision: 0,
			toolExecutionDisposed: false,
			approvalSequence: 0,
			approvalPort: { check },
			modelOperationAdmission: { requiresApproval: false },
			clineMessages: [],
			lastMessageTs: undefined,
			workspacePath: "/workspace",
			messageQueueService: new MessageQueueService(),
			providerRef: { deref: () => ({ getState: async () => state }) },
			addToClineMessages: vi.fn(async () => {}),
			saveClineMessages: vi.fn(),
			updateClineMessage: vi.fn(),
			cancelAutoApprovalTimeout: vi.fn(),
			checkpointSave: vi.fn(),
			emit: vi.fn(),
			say: vi.fn(),
		})
	})

	it("classifies authorization separately from questions, output, completion and control asks", () => {
		expect(clineAsks.filter(isAuthorizationAsk)).toEqual([
			"command",
			"tool",
			"browser_action_launch",
			"use_mcp_server",
		])
	})

	it.each(["tool", "command", "browser_action_launch", "use_mcp_server"] as const)(
		"checks direct %s asks once and retains default auto-approval",
		async (type) => {
			expect(await task.ask(type, "payload", false, undefined, true)).toEqual({
				response: "yesButtonClicked",
				text: undefined,
				images: undefined,
			})
			expect(check).toHaveBeenCalledOnce()
			expect(check).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "task",
					instanceId: "instance",
					type,
					text: "payload",
					isProtected: true,
				}),
			)
			expect((task as any).addToClineMessages).toHaveBeenCalledOnce()
		},
	)

	it("denies without creating a prompt even when all actions are auto-approved", async () => {
		check.mockResolvedValue({ decision: "deny", reason: "restricted" })
		expect(await task.ask("tool", "payload", false)).toEqual({ response: "noButtonClicked", text: "restricted" })
		expect((task as any).addToClineMessages).not.toHaveBeenCalled()
	})

	it("cannot override existing command denial", async () => {
		state = { autoApprovalEnabled: true, alwaysAllowExecute: true, allowedCommands: ["*"], deniedCommands: ["rm"] }
		expect((await task.ask("command", "rm a", false)).response).toBe("noButtonClicked")
	})

	it("preserves feedback and images through the original response path", async () => {
		state = undefined
		;(task as any).messageQueueService.addMessage("feedback", ["image"])
		expect(await task.ask("tool", "payload", false)).toEqual({
			response: "yesButtonClicked",
			text: "feedback",
			images: ["image"],
		})
	})

	it("does not consume queued messages as mandatory model-operation approval", async () => {
		;(task as any).modelOperationAdmission.requiresApproval = true
		;(task as any).messageQueueService.addMessage("not an approval")
		const pending = task.ask("tool", "payload", false)
		await vi.waitFor(() => expect((task as any).addToClineMessages).toHaveBeenCalledOnce())
		task.approveAsk()
		expect((await pending).response).toBe("yesButtonClicked")
		expect((task as any).messageQueueService.isEmpty()).toBe(false)
	})

	it.each(["followup", "command_output", "completion_result"] as const)(
		"leaves non-authorization %s on the existing path",
		async (type) => {
			const original = vi
				.spyOn(task as any, "askWithExistingApproval")
				.mockResolvedValue({ response: "messageResponse", text: "answer" })
			expect(await task.ask(type, "question", false)).toEqual({ response: "messageResponse", text: "answer" })
			expect(check).not.toHaveBeenCalled()
			expect(original).toHaveBeenCalledOnce()
		},
	)

	it("preserves partial ask control flow without requesting approval", async () => {
		await expect(task.ask("tool", "streaming", true)).rejects.toBeInstanceOf(AskIgnoredError)
		expect(check).not.toHaveBeenCalled()
	})

	it.each(["reject", "invalid"])("fails closed for %s port replies", async (kind) => {
		if (kind === "reject") check.mockRejectedValue(new Error("broken"))
		else check.mockResolvedValue(undefined)
		expect((await task.ask("tool", "payload")).response).toBe("noButtonClicked")
		expect((task as any).addToClineMessages).not.toHaveBeenCalled()
	})

	it.each(["abort", "modelOperationClosed", "toolExecutionDisposed", "modelOperationRevision", "lastMessageTs"])(
		"rejects a stale port response after %s changes",
		async (field) => {
			let release!: (value: unknown) => void
			check.mockImplementation(
				() =>
					new Promise((resolve) => {
						release = resolve
					}),
			)
			const pending = task.ask("tool", "payload")
			const rejected = expect(pending).rejects.toThrow()
			;(task as any)[field] = field === "modelOperationRevision" || field === "lastMessageTs" ? 1 : true
			release({ decision: "continue" })
			await rejected
			expect((task as any).addToClineMessages).not.toHaveBeenCalled()
		},
	)

	it("invalidates an older asynchronous port response even for same-timestamp asks", async () => {
		let release!: (value: unknown) => void
		check.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const old = task.ask("tool", "old")
		const rejected = expect(old).rejects.toBeInstanceOf(AskIgnoredError)
		expect((await task.ask("tool", "new")).response).toBe("yesButtonClicked")
		release({ decision: "continue" })
		await rejected
		expect((task as any).addToClineMessages).toHaveBeenCalledOnce()
	})

	it.each([1, 2])("intercepts the real file reader's direct approval for %i files", async (count) => {
		check.mockResolvedValue({ decision: "deny" })
		const files = Array.from({ length: count }, (_, i) => ({
			path: `file${i}.ts`,
			entry: { path: `file${i}.ts`, mode: "slice" },
		}))
		const update = vi.fn()
		await (readFileTool as any).requestApproval(task, files, update)
		expect(check).toHaveBeenCalledOnce()
		expect(JSON.parse(check.mock.calls[0][0].text).tool).toBe("readFile")
		expect(update).toHaveBeenCalledTimes(count)
		for (const [, result] of update.mock.calls) expect(result.status).toBe("denied")
		expect(task.didRejectTool).toBe(true)
	})

	it("keeps the no-port default path unchanged", async () => {
		;(task as any).approvalPort = undefined
		expect((await task.ask("tool", "payload")).response).toBe("yesButtonClicked")
		expect(check).not.toHaveBeenCalled()
	})

	it("preserves individual batch responses and attached images", async () => {
		state = undefined
		const pending = task.ask(
			"tool",
			JSON.stringify({ tool: "readFile", batchFiles: [{ key: "a" }, { key: "b" }] }),
			false,
		)
		await vi.waitFor(() => expect((task as any).addToClineMessages).toHaveBeenCalledOnce())
		task.handleWebviewAskResponse("messageResponse", '{"a":true,"b":false}', ["image"])
		expect(await pending).toEqual({ response: "messageResponse", text: '{"a":true,"b":false}', images: ["image"] })
		expect(check).toHaveBeenCalledOnce()
	})

	it.each(["abort", "toolExecutionDisposed", "modelOperationRevision"])(
		"rejects approval if %s changes after the prompt opens",
		async (field) => {
			state = undefined
			const pending = task.ask("tool", "payload", false)
			const rejected = expect(pending).rejects.toThrow()
			await vi.waitFor(() => expect((task as any).addToClineMessages).toHaveBeenCalledOnce())
			;(task as any)[field] = field === "modelOperationRevision" ? 1 : true
			task.approveAsk()
			await rejected
		},
	)
})
