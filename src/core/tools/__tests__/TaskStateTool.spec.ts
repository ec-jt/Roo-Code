import type { Task } from "../../task/Task"
import { TaskStateTool } from "../TaskStateTool"
import { taskStateTransaction, recordTaskStateMilestone } from "../../../services/task-state/taskState"

vi.mock("../../../services/task-state/taskState", () => ({
	taskStateTransaction: vi.fn(),
	recordTaskStateMilestone: vi.fn(async () => {}),
}))
vi.mock("../../../services/task-state/render", () => ({ renderTaskState: vi.fn(() => "RENDERED") }))

const revision = "b".repeat(64)
const ops = JSON.stringify([{ op: "set", field: "nextAction", value: "Run tests" }])

describe("TaskStateTool loose arguments", () => {
	const tool = new TaskStateTool()
	let task: Task
	let store: any
	let callbacks: any

	beforeEach(() => {
		vi.clearAllMocks()
		store = {
			read: vi.fn(async () => ({ revision, snapshot: { data: {} }, policy: { recallEnabled: true } })),
			patch: vi.fn(async () => ({})),
		}
		vi.mocked(taskStateTransaction).mockResolvedValue({
			store,
			options: { authorize: vi.fn(async () => {}), validHistoryAnchors: [] },
		} as any)
		task = {
			didToolFailInCurrentTurn: false,
			consecutiveMistakeCount: 0,
			providerRef: { deref: () => ({ getState: async () => ({ mode: "code", customModes: [] }) }) },
		} as unknown as Task
		callbacks = { askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError: vi.fn() }
	})

	it('reads with the DeepSeek payload {action:"read", operations:""}', async () => {
		await tool.execute({ action: "read", operations: "" } as any, task, callbacks)
		expect(taskStateTransaction).toHaveBeenCalledWith(task, null)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(`Ledger revision: ${revision}\nRENDERED`)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("returns revision guidance for patch without expected_revision and does not write", async () => {
		await tool.execute({ action: "patch", operations: ops } as any, task, callbacks)
		const message = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(message).toContain("REVISION_REQUIRED")
		expect(message).toContain('action "read" first')
		expect(message).toContain("expected_revision")
		expect(store.patch).not.toHaveBeenCalled()
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(taskStateTransaction).not.toHaveBeenCalled()
		// Tool error path, not a schema failure feeding the mistake limit.
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it('reads with the literal string "null" (DeepSeek 4.2.85 payload) and "NULL "', async () => {
		await tool.execute({ action: "read", operations: "null" } as any, task, callbacks)
		await tool.execute({ action: "read", expected_revision: "NULL ", operations: "NULL " } as any, task, callbacks)
		expect(taskStateTransaction).toHaveBeenNthCalledWith(1, task, null)
		expect(taskStateTransaction).toHaveBeenNthCalledWith(2, task, null)
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(1, `Ledger revision: ${revision}\nRENDERED`)
		expect(callbacks.pushToolResult).toHaveBeenNthCalledWith(2, `Ledger revision: ${revision}\nRENDERED`)
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it.each(["null", "NULL "])(
		'returns REVISION_REQUIRED for patch with expected_revision "%s" and does not write',
		async (value) => {
			await tool.execute({ action: "patch", expected_revision: value, operations: ops } as any, task, callbacks)
			expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("REVISION_REQUIRED")
			expect(taskStateTransaction).not.toHaveBeenCalled()
			expect(store.patch).not.toHaveBeenCalled()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(task.consecutiveMistakeCount).toBe(0)
		},
	)

	it("returns DISABLED with enable guidance, without a mistake or a failed-turn flag", async () => {
		store.read.mockResolvedValue({ revision: null, snapshot: null, policy: { recallEnabled: true } })
		await tool.execute({ action: "read", expected_revision: null, operations: null }, task, callbacks)
		const message = callbacks.pushToolResult.mock.calls[0][0] as string
		expect(message).toMatch(/^DISABLED: /)
		expect(message).toContain("Ask the user to enable task state in the task panel")
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("patches as before with a strict-form call", async () => {
		await tool.execute({ action: "patch", expected_revision: revision, operations: ops }, task, callbacks)
		expect(store.patch).toHaveBeenCalledTimes(1)
		expect(recordTaskStateMilestone).toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(`Ledger revision: ${revision}\nRENDERED`)
	})

	it("reads as before with a strict-form call", async () => {
		await tool.execute({ action: "read", expected_revision: null, operations: null }, task, callbacks)
		expect(store.patch).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(`Ledger revision: ${revision}\nRENDERED`)
	})
})
