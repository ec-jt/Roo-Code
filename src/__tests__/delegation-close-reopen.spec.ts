import type { HistoryItem } from "@roo-code/types"
import { formatSubtaskHandoff } from "../core/task/subtask-handoff"

vi.mock("vscode", () => ({
	window: {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn((_key, fallback) => fallback) })),
		workspaceFolders: [],
	},
	env: { machineId: "test", uriScheme: "vscode", language: "en" },
	Uri: { file: (path: string) => ({ fsPath: path }) },
}))
vi.mock("../core/task/Task", () => ({ Task: vi.fn() }))
vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn(async () => [{ type: "say", say: "text", text: "Parent request", ts: 1 }]),
}))
vi.mock("../core/task-persistence", () => ({
	readApiMessages: vi.fn(async () => [
		{ role: "assistant", content: [{ type: "tool_use", name: "new_task", id: "delegation-1", input: {} }] },
	]),
	saveApiMessages: vi.fn(async () => {}),
	saveTaskMessages: vi.fn(async () => {}),
}))

import { ClineProvider } from "../core/webview/ClineProvider"
import { Task } from "../core/task/Task"
import { attemptCompletionTool } from "../core/tools/AttemptCompletionTool"
import { saveApiMessages, saveTaskMessages } from "../core/task-persistence"

function fixture() {
	const histories: Record<string, HistoryItem> = Object.fromEntries(
		["parent", "child", "unrelated"].map((id) => [
			id,
			{ id, number: 1, ts: 1, task: id, tokensIn: 0, tokensOut: 0, totalCost: 0, status: "active" },
		]),
	)
	Object.assign(histories.parent, {
		status: "delegated",
		awaitingChildId: "child",
		delegatedToId: "child",
		childIds: ["child"],
	})
	histories.child.parentTaskId = "parent"
	const provider = Object.create(ClineProvider.prototype) as ClineProvider
	Object.assign(provider, {
		clineStack: [],
		delegationRevision: 0,
		taskEventListeners: new WeakMap(),
		contextProxy: { globalStorageUri: { fsPath: "/test/storage" } },
		getState: vi.fn(async () => ({ apiConfiguration: {} })),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { ...histories[id] } })),
		updateTaskHistory: vi.fn(async (item: HistoryItem) => {
			histories[item.id] = { ...item }
		}),
		addClineToStack: vi.fn(async (task: Task) => (provider as any).clineStack.push(task)),
		performPreparationTasks: vi.fn(async () => {}),
		getPendingEditOperation: vi.fn(),
		postMessageToWebview: vi.fn(async () => {}),
		emit: vi.fn(),
		log: vi.fn(),
	})
	let instance = 0
	vi.mocked(Task).mockImplementation(({ historyItem, initialStatus }) => {
		// A resumed parent must lose its pending return before it can start writing.
		expect(histories[historyItem!.id].status).toBe(initialStatus)
		return {
			taskId: historyItem!.id,
			instanceId: `instance-${++instance}`,
			parentTaskId: historyItem!.parentTaskId,
			providerRef: { deref: () => provider },
			emit: vi.fn(),
			abortTask: vi.fn(async () => {}),
			say: vi.fn(async () => {}),
			ask: vi.fn(),
			assertCanDelegate: vi.fn(async () => {}),
			getTokenUsage: vi.fn(() => ({})),
			toolUsage: {},
			overwriteClineMessages: vi.fn(async () => {}),
			overwriteApiConversationHistory: vi.fn(async () => {}),
			resumeAfterDelegation: vi.fn(async () => {}),
		} as unknown as Task
	})
	const callbacks = {
		askApproval: vi.fn(async () => false),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		toolDescription: () => "complete",
	}
	return {
		provider,
		histories,
		callbacks,
		open: (id: string) => provider.showTaskWithId(id),
		complete: () =>
			attemptCompletionTool.execute({ result: "Child summary" }, provider.getCurrentTask()!, callbacks),
	}
}

describe("delegated child suspension and history resume", () => {
	beforeEach(() => vi.clearAllMocks())

	it("returns a background child to its parent without foregrounding or abandoning delegation", async () => {
		const f = fixture()
		await f.open("child")
		const child = f.provider.getCurrentTask()!
		await f.provider.handleRunningTaskControl("backgroundTask", child.taskId, child.instanceId)
		expect(child.abortTask).not.toHaveBeenCalled()
		await f.complete()
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
		expect(f.provider.getCurrentTask()!.taskId).toBe("parent")
		expect(f.provider.isTaskBackgrounded).toBe(true)
		expect(f.histories.child.status).toBe("completed")
		expect(f.histories.parent.awaitingChildId).toBeUndefined()
		expect(f.provider.getCurrentTask()!.resumeAfterDelegation).toHaveBeenCalledOnce()
	})

	it.each(["close", "history-navigation"])("returns a reopened unfinished child after %s", async (action) => {
		const f = fixture()
		await f.open("child")
		const originalChild = f.provider.getCurrentTask()!
		if (action === "close") await f.provider.clearTask()
		else await f.open("unrelated")
		expect(originalChild.abortTask).toHaveBeenCalledWith(true)
		expect(f.histories.parent).toMatchObject({ status: "delegated", awaitingChildId: "child" })
		expect(f.histories.child.status).toBe("active")
		await f.open("child")
		expect(f.provider.getCurrentTask()).not.toBe(originalChild)
		await f.complete()
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
		expect(f.histories.child.status).toBe("completed")
		expect(f.histories.parent).toMatchObject({
			status: "active",
			awaitingChildId: undefined,
			completedByChildId: "child",
		})
		expect(f.provider.getCurrentTask()!.taskId).toBe("parent")
		expect(f.provider.getCurrentTask()!.resumeAfterDelegation).toHaveBeenCalledOnce()
		expect(saveApiMessages).toHaveBeenCalledOnce()
		expect(vi.mocked(saveApiMessages).mock.calls[0][0].messages.at(-1)?.content).toEqual([
			{
				type: "tool_result",
				tool_use_id: "delegation-1",
				content: formatSubtaskHandoff("child", "Child summary"),
			},
		])
	})

	it("preserves the pending return when the current child is rehydrated", async () => {
		const f = fixture()
		await f.open("child")
		await f.provider.createTaskWithHistoryItem(f.histories.child)
		expect(f.histories.parent.awaitingChildId).toBe("child")
		await f.complete()
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
		expect(f.histories.child.status).toBe("completed")
	})

	it.each(["resumed-parent", "completed-parent", "different-child", "legacy-cleared-link"])(
		"does not reattach a child after %s",
		async (action) => {
			const f = fixture()
			await f.open("child")
			await f.provider.clearTask()
			if (action === "resumed-parent") {
				await f.open("parent")
				expect(f.histories.parent).toMatchObject({ status: "active", awaitingChildId: undefined })
			} else if (action === "completed-parent") {
				f.histories.parent.status = "completed"
			} else if (action === "different-child") {
				Object.assign(f.histories.parent, { awaitingChildId: "new-child", delegatedToId: "new-child" })
			} else {
				Object.assign(f.histories.parent, { status: "active", awaitingChildId: undefined })
			}
			const parentBefore = { ...f.histories.parent }
			await f.open("child")
			await f.complete()
			expect(f.callbacks.handleError).toHaveBeenCalledOnce()
			expect(f.histories.parent).toEqual(parentBefore)
			expect(f.provider.getCurrentTask()!.taskId).toBe("child")
			expect(saveApiMessages).not.toHaveBeenCalled()
			expect(saveTaskMessages).not.toHaveBeenCalled()
		},
	)

	it("does not start a waiting parent if revoking the pending return fails", async () => {
		const f = fixture()
		vi.mocked(f.provider.updateTaskHistory).mockRejectedValueOnce(new Error("Storage unavailable"))
		await expect(f.open("parent")).rejects.toThrow("Storage unavailable")
		expect(Task).not.toHaveBeenCalled()
		expect(f.histories.parent.awaitingChildId).toBe("child")
	})
})
