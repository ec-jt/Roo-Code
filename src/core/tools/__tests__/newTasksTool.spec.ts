// npx vitest run core/tools/__tests__/newTasksTool.spec.ts

import { newTasksTool } from "../NewTasksTool"
import type { ToolUse } from "../../../shared/tools"

const formatted = vi.hoisted(() => vi.fn((result: { batchId: string }) => `FORMATTED ${result.batchId}`))
vi.mock("../../task/parallel/ParallelTaskPool", () => ({ formatParallelBatchResult: formatted }))

function block(tasks: unknown): ToolUse<"new_tasks"> {
	return {
		type: "tool_use",
		name: "new_tasks",
		params: {},
		nativeArgs: { tasks } as any,
		partial: false,
	} as ToolUse<"new_tasks">
}

const TWO = [
	{ mode: "code", message: "Implement feature A in src/a.ts" },
	{ mode: "debug", message: "Investigate flaky test B\nwith details" },
]

describe("NewTasksTool", () => {
	let task: any
	let provider: any
	let pool: any
	let askApproval: ReturnType<typeof vi.fn>
	let pushToolResult: ReturnType<typeof vi.fn>
	let handleError: ReturnType<typeof vi.fn>

	beforeEach(() => {
		vi.clearAllMocks()
		pool = {
			startBatch: vi.fn(async () => "batch-1"),
			waitForBatch: vi.fn(async () => ({ batchId: "batch-1", children: [] })),
		}
		task = {
			taskId: "parent",
			parentTaskId: undefined,
			nonInteractive: undefined,
			abort: false,
			abandoned: false,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			assertCanDelegate: vi.fn(async () => {}),
			ask: vi.fn(async () => ({})),
		}
		provider = {
			getState: vi.fn(async () => ({
				customModes: [],
				parallelSubtasksConcurrency: 3,
				parallelSubtasksTokenBudget: 500_000,
			})),
			getCurrentTask: vi.fn(() => task),
			parallelTaskPool: pool,
		}
		task.providerRef = { deref: () => provider }
		askApproval = vi.fn(async () => true)
		pushToolResult = vi.fn()
		handleError = vi.fn()
	})

	const run = (tasks: unknown) =>
		newTasksTool.handle(task, block(tasks), { askApproval, handleError, pushToolResult })

	describe("validation", () => {
		it.each([
			["one task", [TWO[0]]],
			["five tasks", [...TWO, ...TWO, TWO[0]]],
			["not an array", "nope"],
		])("rejects %s without asking or starting", async (_label, tasks) => {
			await run(tasks)
			expect(askApproval).not.toHaveBeenCalled()
			expect(pool.startBatch).not.toHaveBeenCalled()
			expect(pushToolResult.mock.calls[0][0]).toContain("2 to 4 tasks")
			expect(task.consecutiveMistakeCount).toBe(1)
			expect(task.didToolFailInCurrentTurn).toBe(true)
		})

		it("rejects an unknown mode slug", async () => {
			await run([TWO[0], { mode: "no-such-mode", message: "x" }])
			expect(pushToolResult.mock.calls[0][0]).toContain("Task 2: unknown mode")
			expect(askApproval).not.toHaveBeenCalled()
			expect(pool.startBatch).not.toHaveBeenCalled()
		})

		it("rejects an empty message", async () => {
			await run([TWO[0], { mode: "code", message: "   " }])
			expect(pushToolResult.mock.calls[0][0]).toContain("Task 2: the message is empty")
			expect(askApproval).not.toHaveBeenCalled()
		})
	})

	it("asks for one approval with the full batch payload", async () => {
		await run(TWO)
		expect(askApproval).toHaveBeenCalledTimes(1)
		const [type, text] = askApproval.mock.calls[0]
		expect(type).toBe("tool")
		expect(JSON.parse(text)).toEqual({ tool: "newTasks", tasks: TWO, concurrency: 3, tokenBudget: 500_000 })
	})

	it("clamps the settings it shows and runs with", async () => {
		provider.getState.mockResolvedValue({ customModes: [], parallelSubtasksConcurrency: 9 })
		await run(TWO)
		const payload = JSON.parse(askApproval.mock.calls[0][1])
		expect(payload).toMatchObject({ concurrency: 4, tokenBudget: 2_000_000 })
		expect(pool.startBatch).toHaveBeenCalledWith(
			expect.objectContaining({ concurrency: 4, tokenBudget: 2_000_000 }),
		)
	})

	it("a denied approval starts no batch", async () => {
		askApproval.mockResolvedValue(false)
		await run(TWO)
		expect(pool.startBatch).not.toHaveBeenCalled()
		expect(pool.waitForBatch).not.toHaveBeenCalled()
		expect(pushToolResult).not.toHaveBeenCalled()
	})

	it("an approved call starts the batch, waits, and pushes the formatted result", async () => {
		await run(TWO)
		expect(pool.startBatch).toHaveBeenCalledWith({
			parent: task,
			children: TWO,
			concurrency: 3,
			tokenBudget: 500_000,
		})
		expect(pool.waitForBatch).toHaveBeenCalledWith("batch-1")
		expect(formatted).toHaveBeenCalledWith({ batchId: "batch-1", children: [] })
		expect(pushToolResult).toHaveBeenCalledWith("FORMATTED batch-1")
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("a startBatch error becomes a tool error and nothing is awaited", async () => {
		pool.startBatch.mockRejectedValue(new Error("not a git repository"))
		await run(TWO)
		expect(pool.waitForBatch).not.toHaveBeenCalled()
		expect(pushToolResult.mock.calls[0][0]).toContain("Cannot start parallel subtasks: not a git repository")
		expect(pushToolResult.mock.calls[0][0]).toContain("No subtask was started")
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(handleError).not.toHaveBeenCalled()
	})

	it("returns cleanly without a result when the parent was stopped while waiting", async () => {
		pool.waitForBatch.mockImplementation(async () => {
			task.abort = true
			return { batchId: "batch-1", children: [] }
		})
		await run(TWO)
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(handleError).not.toHaveBeenCalled()
	})

	describe("never a weaker path than new_task (Q-SEC-3)", () => {
		it("refuses in a parallel child", async () => {
			task.nonInteractive = { answerAsk: vi.fn() }
			await run(TWO)
			expect(askApproval).not.toHaveBeenCalled()
			expect(pool.startBatch).not.toHaveBeenCalled()
		})

		it("refuses in a depth-1 task (nested delegation keeps the new_task fence)", async () => {
			task.parentTaskId = "root"
			await run(TWO)
			expect(askApproval).not.toHaveBeenCalled()
			expect(pushToolResult.mock.calls[0][0]).toContain("root task (depth 0)")
		})

		it("refuses when the task is not the current task", async () => {
			provider.getCurrentTask.mockReturnValue({})
			await run(TWO)
			expect(askApproval).not.toHaveBeenCalled()
		})

		it("refuses from a model-operation branch or closed task", async () => {
			task.assertCanDelegate.mockRejectedValue(
				new Error("Delegation is not allowed from a model-operation branch"),
			)
			await run(TWO)
			expect(askApproval).not.toHaveBeenCalled()
			expect(pushToolResult.mock.calls[0][0]).toContain("model-operation branch")
		})
	})
})
