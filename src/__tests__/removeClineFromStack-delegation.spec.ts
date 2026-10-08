// npx vitest run __tests__/removeClineFromStack-delegation.spec.ts

import { ClineProvider } from "../core/webview/ClineProvider"

describe("ClineProvider.removeClineFromStack() delegation awareness", () => {
	/**
	 * Helper to build a minimal mock provider with a single task on the stack.
	 * The task's parentTaskId and taskId are configurable.
	 */
	function buildMockProvider(opts: {
		childTaskId: string
		parentTaskId?: string
		parentHistoryItem?: Record<string, any>
		getTaskWithIdError?: Error
	}) {
		const childTask = {
			taskId: opts.childTaskId,
			instanceId: "inst-1",
			parentTaskId: opts.parentTaskId,
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const updateTaskHistory = vi.fn().mockResolvedValue([])
		const getTaskWithId = opts.getTaskWithIdError
			? vi.fn().mockRejectedValue(opts.getTaskWithIdError)
			: vi.fn().mockImplementation(async (id: string) => {
					if (id === opts.parentTaskId && opts.parentHistoryItem) {
						return { historyItem: { ...opts.parentHistoryItem } }
					}
					throw new Error("Task not found")
				})

		const provider = {
			delegationRevision: 0,
			assertTaskForegrounded: vi.fn(),
			runningTaskMonitor: { clear: vi.fn() },
			getCurrentTask: (): any => provider.clineStack.at(-1),
			clineStack: [childTask] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
		}

		return { provider, childTask, updateTaskHistory, getTaskWithId }
	}

	it("awaits asynchronous task cleanup before completing removal", async () => {
		const { provider, childTask } = buildMockProvider({ childTaskId: "browser-owner" })
		let finish!: () => void
		childTask.abortTask.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const removeListeners = vi.fn()
		provider.taskEventListeners.set(childTask, [removeListeners])
		let completed = false
		const removing = ClineProvider.prototype.removeClineFromStack.call(provider as any).then(() => {
			completed = true
		})
		await Promise.resolve()
		expect(childTask.abortTask).toHaveBeenCalledWith(true)
		expect(completed).toBe(false)
		expect(removeListeners).not.toHaveBeenCalled()
		finish()
		await removing
		expect(removeListeners).toHaveBeenCalledOnce()
		expect(provider.taskEventListeners.has(childTask)).toBe(false)
	})

	it("retains the task and listeners when durability fails", async () => {
		const { provider, childTask } = buildMockProvider({ childTaskId: "failed-save" })
		childTask.abortTask.mockRejectedValue(new Error("disk full"))
		const cleanup = vi.fn()
		provider.taskEventListeners.set(childTask, [cleanup])
		await expect(ClineProvider.prototype.removeClineFromStack.call(provider as any)).rejects.toThrow("disk full")
		expect(provider.clineStack).toEqual([childTask])
		expect(cleanup).not.toHaveBeenCalled()
	})

	it("repairs parent metadata when a delegated child is explicitly abandoned", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		// Stack should be empty after pop
		expect(provider.clineStack).toHaveLength(0)

		// Parent lookup should have been called
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")

		// Parent metadata should be repaired
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)
		const updatedParent = updateTaskHistory.mock.calls[0][0]
		expect(updatedParent).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "active",
				awaitingChildId: undefined,
			}),
		)

		// Log the repair
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Repaired parent parent-1 metadata"))
	})

	it("does NOT modify parent metadata when the task has no parentTaskId (non-delegated)", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "standalone-1",
			// No parentTaskId — this is a top-level task
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		// Stack should be empty
		expect(provider.clineStack).toHaveLength(0)

		// No parent lookup or update should happen
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when awaitingChildId does not match the popped child", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-OTHER", // different child
				delegatedToId: "child-OTHER",
				childIds: ["child-OTHER"],
			},
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		// Parent was looked up but should NOT be updated
		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT modify parent metadata when parent status is not 'delegated'", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "completed", // already completed
				awaitingChildId: "child-1",
				childIds: ["child-1"],
			},
		})

		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		expect(getTaskWithId).toHaveBeenCalledWith("parent-1")
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("catches and logs errors during parent metadata repair without blocking the pop", async () => {
		const { provider, childTask, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			getTaskWithIdError: new Error("Storage unavailable"),
		})

		// Should NOT throw
		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		// Stack should still be empty (pop was not blocked)
		expect(provider.clineStack).toHaveLength(0)

		// The abort should still have been called
		expect(childTask.abortTask).toHaveBeenCalledWith(true)

		// Error should be logged as non-fatal
		expect(provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Failed to repair parent metadata for parent-1 (non-fatal)"),
		)

		// No update should have been attempted
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("handles empty stack gracefully", async () => {
		const provider = {
			assertTaskForegrounded: vi.fn(),
			clineStack: [] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId: vi.fn(),
			updateTaskHistory: vi.fn(),
		}

		// Should not throw
		await (ClineProvider.prototype as any).removeClineFromStack.call(provider, { abandonDelegation: true })

		expect(provider.clineStack).toHaveLength(0)
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
	})

	it("preserves delegation when an unfinished child is closed normally", async () => {
		const { provider, updateTaskHistory, getTaskWithId } = buildMockProvider({
			childTaskId: "child-1",
			parentTaskId: "parent-1",
			parentHistoryItem: {
				id: "parent-1",
				task: "Parent task",
				ts: 1000,
				number: 1,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				awaitingChildId: "child-1",
				delegatedToId: "child-1",
				childIds: ["child-1"],
			},
		})

		// Ordinary close suspends the child without revoking its return.
		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		// Stack should be empty after pop
		expect(provider.clineStack).toHaveLength(0)

		// Parent lookup should NOT have been called — repair was skipped entirely
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does NOT reset grandparent during A→B→C nested delegation transition", async () => {
		// Scenario: A delegated to B, B is now delegating to C.
		// delegateParentAndOpenChild() suspends B via removeClineFromStack().
		// Grandparent A should remain "delegated" — its metadata must not be repaired.
		const grandparentHistory = {
			id: "task-A",
			task: "Grandparent task",
			ts: 1000,
			number: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			status: "delegated",
			awaitingChildId: "task-B",
			delegatedToId: "task-B",
			childIds: ["task-B"],
		}

		const taskB = {
			taskId: "task-B",
			instanceId: "inst-B",
			parentTaskId: "task-A",
			emit: vi.fn(),
			abortTask: vi.fn().mockResolvedValue(undefined),
		}

		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "task-A") {
				return { historyItem: { ...grandparentHistory } }
			}
			throw new Error("Task not found")
		})
		const updateTaskHistory = vi.fn().mockResolvedValue([])

		const provider = {
			assertTaskForegrounded: vi.fn(),
			runningTaskMonitor: { clear: vi.fn() },
			getCurrentTask: (): any => provider.clineStack.at(-1),
			clineStack: [taskB] as any[],
			taskEventListeners: new Map(),
			log: vi.fn(),
			getTaskWithId,
			updateTaskHistory,
		}

		// Simulate what delegateParentAndOpenChild does: suspend B.
		await (ClineProvider.prototype as any).removeClineFromStack.call(provider)

		// B was popped
		expect(provider.clineStack).toHaveLength(0)

		// Grandparent A should NOT have been looked up or modified
		expect(getTaskWithId).not.toHaveBeenCalled()
		expect(updateTaskHistory).not.toHaveBeenCalled()

		// Grandparent A's metadata remains intact (delegated, awaitingChildId: task-B)
		// The caller updates B to await C; A continues waiting for B.
	})
})
