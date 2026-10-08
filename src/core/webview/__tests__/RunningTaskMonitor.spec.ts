import EventEmitter from "events"
import { RooCodeEventName, type ClineAsk } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { RunningTaskMonitor } from "../RunningTaskMonitor"

function task(taskId = "task", instanceId = "instance") {
	return Object.assign(new EventEmitter(), {
		taskId,
		instanceId,
		metadata: { task: "Current task" },
		taskAsk: undefined as { ask: ClineAsk } | undefined,
		abortReason: undefined as string | undefined,
	}) as unknown as Task
}

describe("RunningTaskMonitor", () => {
	afterEach(() => vi.useRealTimers())

	it("keeps session time through approval waits without polling and freezes terminal time", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1000)
		const current = task()
		const publish = vi.fn()
		const monitor = new RunningTaskMonitor(() => current, publish)
		monitor.track(current)
		current.emit(RooCodeEventName.TaskFocused)
		expect(monitor.value).toMatchObject({ startedAt: 1000, title: "Current task", status: "running" })
		vi.setSystemTime(4000)
		Object.assign(current, { taskAsk: { ask: "tool" } })
		current.emit(RooCodeEventName.TaskInteractive, current.taskId)
		expect(monitor.value).toMatchObject({ startedAt: 1000, status: "approval" })
		expect(monitor.value?.stoppedAt).toBeUndefined()
		monitor.setBackground(true)
		publish.mockClear()
		vi.advanceTimersByTime(5000)
		expect(publish).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		Object.assign(current, { taskAsk: { ask: "completion_result" } })
		current.emit(RooCodeEventName.TaskIdle, current.taskId)
		expect(monitor.value).toMatchObject({ startedAt: 1000, stoppedAt: 9000, status: "completed", background: true })
		vi.setSystemTime(12000)
		current.emit(RooCodeEventName.TaskIdle, current.taskId)
		expect(monitor.value?.stoppedAt).toBe(9000)
		current.emit(RooCodeEventName.TaskActive, current.taskId)
		expect(monitor.value?.startedAt).toBe(1000)
		expect(monitor.value?.stoppedAt).toBeUndefined()
	})

	it.each([
		["followup", "input"],
		["resume_task", "input"],
		["api_req_failed", "failed"],
		["resume_completed_task", "completed"],
		["command", "approval"],
		["use_mcp_server", "approval"],
	] as const)("classifies %s as %s", (ask, status) => {
		const current = task()
		const monitor = new RunningTaskMonitor(() => current, vi.fn())
		monitor.track(current)
		Object.assign(current, { taskAsk: { ask } })
		current.emit(RooCodeEventName.TaskInteractive, current.taskId)
		expect(monitor.value?.status).toBe(status)
	})

	it("preserves background through sequential handoffs but starts a new clock per instance", () => {
		vi.useFakeTimers()
		vi.setSystemTime(1000)
		const parent = task("parent", "first")
		let current: Task | undefined = parent
		const monitor = new RunningTaskMonitor(() => current, vi.fn())
		const cleanup = monitor.track(parent)
		monitor.activate(parent)
		monitor.setBackground(true)
		current = undefined
		cleanup()
		vi.setSystemTime(2000)
		current = task("child")
		monitor.track(current)
		monitor.activate(current)
		expect(monitor.value).toMatchObject({ taskId: "child", background: true, startedAt: 2000 })
		parent.emit(RooCodeEventName.TaskAborted)
		expect(monitor.value?.taskId).toBe("child")
		vi.setSystemTime(3000)
		current = task("parent", "reopened")
		monitor.track(current)
		monitor.activate(current)
		expect(monitor.value).toMatchObject({
			taskId: "parent",
			instanceId: "reopened",
			startedAt: 3000,
			background: true,
		})
		monitor.clear()
		expect(monitor.value).toBeUndefined()
		expect(monitor.background).toBe(false)
	})

	it("handles cancellation and streaming failure and detaches all listeners", () => {
		const current = task()
		const monitor = new RunningTaskMonitor(() => current, vi.fn())
		const cleanup = monitor.track(current)
		current.emit(RooCodeEventName.TaskAborted)
		expect(monitor.value?.status).toBe("cancelled")
		current.abortReason = "streaming_failed"
		current.emit(RooCodeEventName.TaskAborted)
		expect(monitor.value?.status).toBe("failed")
		cleanup()
		monitor.clear()
		expect(current.eventNames()).toEqual([])
		current.emit(RooCodeEventName.TaskStarted)
		expect(monitor.value).toBeUndefined()
	})

	it("reflects state-driven model approvals without resetting the session clock", () => {
		const current = task()
		const monitor = new RunningTaskMonitor(() => current, vi.fn())
		monitor.track(current)
		monitor.activate(current)
		const startedAt = monitor.value?.startedAt
		Object.assign(current, { modelOperationState: { approval: { approvalId: "approval" } } })
		monitor.syncApproval()
		expect(monitor.value).toMatchObject({ status: "approval", startedAt })
		Object.assign(current, { modelOperationState: {} })
		monitor.syncApproval()
		expect(monitor.value).toMatchObject({ status: "running", startedAt })
		Object.assign(current, { abort: true })
		current.emit(RooCodeEventName.TaskAborted)
		current.emit(RooCodeEventName.TaskActive, current.taskId)
		expect(monitor.value?.status).toBe("cancelled")
	})
})
