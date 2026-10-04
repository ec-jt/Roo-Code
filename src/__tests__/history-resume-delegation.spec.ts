// npx vitest run __tests__/history-resume-delegation.spec.ts

import { RooCodeEventName } from "@roo-code/types"

/* vscode mock for Task/Provider imports */
vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

// Mock persistence BEFORE importing provider
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", () => ({
	readApiMessages: vi.fn().mockResolvedValue([]),
	saveApiMessages: vi.fn().mockResolvedValue(undefined),
	saveTaskMessages: vi.fn().mockResolvedValue(undefined),
}))

import { ClineProvider } from "../core/webview/ClineProvider"
import { readTaskMessages } from "../core/task-persistence/taskMessages"
import { readApiMessages, saveApiMessages, saveTaskMessages } from "../core/task-persistence"

import { Task } from "../core/task/Task"
import { attemptCompletionTool } from "../core/tools/AttemptCompletionTool"
import { getEnvironmentDetails } from "../core/environment/getEnvironmentDetails"

vi.mock("../core/environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn(async () => "<environment_details>fresh</environment_details>"),
}))

function fixture() {
	const histories: Record<string, any> = {
		parent: {
			id: "parent",
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		},
		child: { id: "child", status: "active", parentTaskId: "parent" },
	}
	let ui: any[] = [{ type: "say", say: "text", text: "Parent request", ts: 1 }]
	let api: any[] = [
		{ role: "assistant", content: [{ type: "tool_use", name: "new_task", id: "new-task-1", input: {} }] },
	]
	let current: any
	const parent: any = {
		taskId: "parent",
		instanceId: "parent-instance",
		apiConversationHistory: [],
		assertCanDelegate: vi.fn(async () => {}),
		emit: vi.fn(),
		initiateTaskLoop: vi.fn(() => new Promise(() => {})),
		saveApiConversationHistory: vi.fn(async () => true),
		overwriteClineMessages: vi.fn(async (messages) => {
			parent.clineMessages = messages
		}),
		overwriteApiConversationHistory: vi.fn(async (messages) => {
			parent.apiConversationHistory = messages
		}),
		resumeAfterDelegation: vi.fn(async () => Task.prototype.resumeAfterDelegation.call(parent)),
	}
	const child: any = {
		taskId: "child",
		instanceId: "child-instance",
		parentTaskId: "parent",
		say: vi.fn(),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
		emit: vi.fn(),
		assertCanDelegate: vi.fn(async () => {}),
		getTokenUsage: vi.fn(() => ({})),
		emitFinalTokenUsageUpdate: vi.fn(),
		recordToolError: vi.fn(),
		toolUsage: {},
	}
	current = child
	const provider: any = {
		delegationRevision: 0,
		contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
		getState: vi.fn(async () => ({ autoApprovalEnabled: false, alwaysAllowSubtasks: false })),
		getCurrentTask: vi.fn(() => current),
		emit: vi.fn(),
		log: vi.fn(),
		getTaskWithId: vi.fn(async (id) => {
			if (!histories[id]) throw new Error("Task not found")
			return { historyItem: histories[id] }
		}),
		updateTaskHistory: vi.fn(async (item) => {
			histories[item.id] = item
		}),
		removeClineFromStack: vi.fn(async () => {
			current = undefined
			provider.delegationRevision++
		}),
		createTaskWithHistoryItem: vi.fn(async (_item, options) => {
			options.assertCurrent?.()
			expect(options.startTask).toBe(false)
			current = parent
			return parent
		}),
		reopenParentFromDelegation: vi.fn(async (params) =>
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, params),
		),
	}
	child.providerRef = parent.providerRef = { deref: () => provider }
	vi.mocked(readTaskMessages).mockImplementation(async () => structuredClone(ui))
	vi.mocked(readApiMessages).mockImplementation(async () => structuredClone(api))
	vi.mocked(saveTaskMessages).mockImplementation(async ({ messages }) => {
		ui = structuredClone(messages)
	})
	vi.mocked(saveApiMessages).mockImplementation(async ({ messages }) => {
		api = structuredClone(messages)
	})
	const callbacks = {
		askApproval: vi.fn(async () => false),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		toolDescription: () => "complete",
	}
	return {
		child,
		parent,
		provider,
		histories,
		callbacks,
		setCurrent: (task: any) => {
			current = task
		},
		ui: () => ui,
		api: () => api,
		complete: () => attemptCompletionTool.execute({ result: "Child summary" }, child, callbacks),
		returnChild: () =>
			provider.reopenParentFromDelegation({
				parentTaskId: "parent",
				childTaskId: "child",
				childInstanceId: "child-instance",
				completionResultSummary: "Child summary",
			}),
	}
}

describe("automatic delegation return", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("automatically delivers exactly one native result and starts the real resume method with auto-approval off", async () => {
		const f = fixture()
		await Promise.all([f.complete(), f.complete()])
		await f.complete()
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
		expect(f.callbacks.askApproval).not.toHaveBeenCalled()
		expect(f.child.ask).not.toHaveBeenCalled()
		expect(f.api().at(-1).content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "new-task-1",
				content: "Subtask child completed.\n\nResult:\nChild summary",
			},
		])
		expect(f.ui().filter((m) => m.say === "subtask_result")).toHaveLength(1)
		expect(f.parent.resumeAfterDelegation).toHaveBeenCalledOnce()
		expect(f.parent.skipPrevResponseIdOnce).toBe(true)
		expect(f.parent.initiateTaskLoop).toHaveBeenCalledExactlyOnceWith([])
		expect(f.parent.apiConversationHistory.at(-1).content).toHaveLength(2)
		expect(f.histories.child.status).toBe("completed")
		expect(f.histories.parent).toMatchObject({
			status: "active",
			completedByChildId: "child",
			awaitingChildId: undefined,
		})
		expect(f.provider.removeClineFromStack).toHaveBeenCalledWith()
		const events = f.provider.emit.mock.calls.map((c: any[]) => c[0])
		expect(events).toEqual([
			RooCodeEventName.TaskCompleted,
			RooCodeEventName.TaskDelegationCompleted,
			RooCodeEventName.TaskDelegationResumed,
		])
		expect(f.provider.emit.mock.calls[0][1]).toBe("child")
		expect(f.child.emit).not.toHaveBeenCalled()
	})

	it("does not attach a legacy child's summary to an older completed delegation turn", async () => {
		const f = fixture()
		vi.mocked(readApiMessages).mockResolvedValueOnce([
			...f.api(),
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "new-task-1", content: "Earlier child" }] },
			{ role: "assistant", content: [{ type: "text", text: "Legacy delegation" }] },
		])
		await f.complete()
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
		expect(f.api()[1].content[0].content).toBe("Earlier child")
		expect(f.api().at(-1).content[0].type).toBe("text")
	})

	it("accepts missing legacy child status only with valid durable linkage", async () => {
		const f = fixture()
		delete f.histories.child.status
		await f.complete()
		expect(f.parent.initiateTaskLoop).toHaveBeenCalledOnce()
	})

	it("does not return a completed child reopened for inspection", async () => {
		const f = fixture()
		f.histories.child.status = "completed"
		await f.complete()
		expect(f.child.ask).toHaveBeenCalledWith("completion_result", "", false)
		expect(f.provider.reopenParentFromDelegation).not.toHaveBeenCalled()
	})

	it.each([
		"missing-parent",
		"wrong-parent",
		"wrong-child",
		"missing-child-id",
		"outstanding-descendant",
		"delegated-child",
	])("blocks invalid lineage: %s", async (kind) => {
		const f = fixture()
		if (kind === "missing-parent") delete f.histories.parent
		if (kind === "wrong-parent") f.histories.child.parentTaskId = "other"
		if (kind === "wrong-child") f.histories.parent.awaitingChildId = "other"
		if (kind === "missing-child-id") f.histories.parent.childIds = []
		if (kind === "outstanding-descendant") f.histories.child.awaitingChildId = "grandchild"
		if (kind === "delegated-child") f.histories.child.status = "delegated"
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalled()
		expect(f.child.ask).not.toHaveBeenCalled()
		expect(f.provider.emit).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
	})

	it.each(["api-read", "ui-read", "empty-api", "empty-ui"])(
		"preserves parent history on %s failure",
		async (kind) => {
			const f = fixture()
			if (kind === "api-read") vi.mocked(readApiMessages).mockRejectedValueOnce(new Error("read failed"))
			if (kind === "ui-read") vi.mocked(readTaskMessages).mockRejectedValueOnce(new Error("read failed"))
			if (kind === "empty-api") vi.mocked(readApiMessages).mockResolvedValueOnce([])
			if (kind === "empty-ui") vi.mocked(readTaskMessages).mockResolvedValueOnce([])
			await f.complete()
			expect(f.callbacks.handleError).toHaveBeenCalled()
			expect(saveApiMessages).not.toHaveBeenCalled()
			expect(saveTaskMessages).not.toHaveBeenCalled()
			expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
		},
	)

	it.each(["switch", "abort", "closed", "revision"])("rejects stale return during history read: %s", async (kind) => {
		const f = fixture()
		vi.mocked(readApiMessages).mockImplementationOnce(async () => {
			if (kind === "switch") f.setCurrent({ taskId: "child", instanceId: "replacement" })
			if (kind === "abort") f.child.abort = true
			if (kind === "closed") f.child.modelOperationDispatchClosed = true
			if (kind === "revision") f.provider.delegationRevision++
			return f.api()
		})
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalled()
		expect(saveTaskMessages).not.toHaveBeenCalled()
		expect(f.parent.initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("deduplicates a retry after partial persistence", async () => {
		const f = fixture()
		vi.mocked(saveApiMessages).mockRejectedValueOnce(new Error("disk full"))
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		await f.complete()
		expect(f.ui().filter((m) => m.say === "subtask_result")).toHaveLength(1)
		expect(f.api().filter((m) => m.role === "user")).toHaveLength(1)
		expect(f.parent.initiateTaskLoop).toHaveBeenCalledOnce()
	})

	it("retries legacy plain-text delivery without duplicating an already-written result", async () => {
		const f = fixture()
		vi.mocked(readApiMessages).mockResolvedValueOnce([{ role: "user", content: "Legacy parent task" }])
		f.provider.removeClineFromStack.mockRejectedValueOnce(new Error("interrupted before close"))
		await f.complete()
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		expect(f.api()).toHaveLength(2)
		expect(f.api().at(-1).content[0]).toEqual({
			type: "text",
			text: "Subtask child completed.\n\nResult:\nChild summary",
		})
		expect(f.parent.initiateTaskLoop).toHaveBeenCalledOnce()
	})

	it("blocks a second direct provider return while delivery is pending", async () => {
		const f = fixture()
		let release!: () => void
		vi.mocked(readApiMessages).mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve
			})
			return f.api()
		})
		const pending = f.returnChild()
		await vi.waitFor(() => expect(release).toBeDefined())
		await expect(f.returnChild()).rejects.toThrow("already in progress")
		release()
		await pending
		expect(f.parent.initiateTaskLoop).toHaveBeenCalledOnce()
	})

	it("does not activate the parent after switch-away-and-back during child disposal", async () => {
		const f = fixture()
		f.provider.removeClineFromStack.mockImplementationOnce(async () => {
			f.setCurrent(undefined)
			f.provider.delegationRevision += 3
		})
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(f.provider.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does not resume on metadata persistence failure", async () => {
		const f = fixture()
		f.provider.updateTaskHistory.mockRejectedValueOnce(new Error("disk full"))
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(f.provider.emit).not.toHaveBeenCalled()
	})

	it("does not resume with failed in-memory history restoration", async () => {
		const f = fixture()
		f.parent.overwriteApiConversationHistory.mockRejectedValueOnce(new Error("disk full"))
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		expect(f.parent.initiateTaskLoop).not.toHaveBeenCalled()
		expect(f.provider.emit).not.toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent", "child")
	})

	it("does not reactivate a parent cancelled while environment details load", async () => {
		const f = fixture()
		vi.mocked(getEnvironmentDetails).mockImplementationOnce(async () => {
			f.parent.abort = true
			return "environment"
		})
		await f.complete()
		expect(f.parent.abort).toBe(true)
		expect(f.parent.initiateTaskLoop).not.toHaveBeenCalled()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
	})

	it("preserves mandatory model-operation restrictions", async () => {
		const f = fixture()
		f.child.assertCanDelegate.mockRejectedValue(new Error("Model-operation branch cannot delegate"))
		await f.complete()
		expect(f.callbacks.handleError).toHaveBeenCalledOnce()
		expect(saveApiMessages).not.toHaveBeenCalled()
	})
})
