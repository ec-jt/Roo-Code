import { RooCodeEventName, type RunningTaskInfo } from "@roo-code/types"
import type { Task } from "../task/Task"

/** In-memory UI state for the single loaded stack. Never changes task execution or permissions. */
export class RunningTaskMonitor {
	private sessions = new WeakMap<Task, RunningTaskInfo>()
	private info?: RunningTaskInfo
	private modelApprovalTask?: Task
	public background = false

	constructor(
		private readonly currentTask: () => Task | undefined,
		private readonly publish: (info: RunningTaskInfo | undefined) => void,
	) {}

	get value(): RunningTaskInfo | undefined {
		return this.info
	}

	track(task: Task): () => void {
		this.sessions.set(task, {
			taskId: task.taskId,
			instanceId: task.instanceId,
			title: task.metadata?.task || "Task",
			startedAt: Date.now(),
			status: "running",
			background: this.background,
		})
		const active = () => this.update(task, "running")
		const completed = () => this.update(task, "completed")
		const aborted = () => this.update(task, task.abortReason === "streaming_failed" ? "failed" : "cancelled")
		const waiting = () => {
			const ask = task.taskAsk?.ask
			this.update(
				task,
				ask === "completion_result" || ask === "resume_completed_task"
					? "completed"
					: ask === "api_req_failed"
						? "failed"
						: ask === "tool" ||
							  ask === "command" ||
							  ask === "use_mcp_server" ||
							  ask === "browser_action_launch"
							? "approval"
							: "input",
			)
		}
		const focused = () => this.activate(task)
		task.on(RooCodeEventName.TaskStarted, active)
		task.on(RooCodeEventName.TaskActive, active)
		task.on(RooCodeEventName.TaskCompleted, completed)
		task.on(RooCodeEventName.TaskAborted, aborted)
		task.on(RooCodeEventName.TaskInteractive, waiting)
		task.on(RooCodeEventName.TaskResumable, waiting)
		task.on(RooCodeEventName.TaskIdle, waiting)
		task.on(RooCodeEventName.TaskFocused, focused)
		return () => {
			if (this.modelApprovalTask === task) this.modelApprovalTask = undefined
			task.off(RooCodeEventName.TaskStarted, active)
			task.off(RooCodeEventName.TaskActive, active)
			task.off(RooCodeEventName.TaskCompleted, completed)
			task.off(RooCodeEventName.TaskAborted, aborted)
			task.off(RooCodeEventName.TaskInteractive, waiting)
			task.off(RooCodeEventName.TaskResumable, waiting)
			task.off(RooCodeEventName.TaskIdle, waiting)
			task.off(RooCodeEventName.TaskFocused, focused)
		}
	}

	activate(task: Task): void {
		const session = this.sessions.get(task)
		if (!session || this.currentTask() !== task) return
		this.info = { ...session, background: this.background }
		this.publish(this.info)
	}

	update(task: Task, status: RunningTaskInfo["status"]): void {
		const session = this.sessions.get(task)
		if (!session || this.currentTask() !== task) return
		if ((task.abort || task.abandoned) && status !== "cancelled" && status !== "failed") return
		const stopped = status === "completed" || status === "cancelled" || status === "failed"
		this.sessions.set(task, {
			...session,
			status,
			stoppedAt: stopped ? (session.stoppedAt ?? Date.now()) : undefined,
		})
		this.activate(task)
	}

	/** Model-operation approvals publish state rather than ordinary Task.ask events. */
	syncApproval(): void {
		const task = this.currentTask()
		if (!task || task.abort || task.abandoned) return
		if (task.modelOperationState?.approval) {
			this.modelApprovalTask = task
			if (this.info?.status !== "approval") this.update(task, "approval")
		} else if (this.modelApprovalTask === task) {
			this.modelApprovalTask = undefined
			this.update(task, "running")
		}
	}

	setBackground(background: boolean): void {
		this.background = background
		const task = this.currentTask()
		if (task) this.activate(task)
	}

	clear(): void {
		this.info = undefined
		this.modelApprovalTask = undefined
		this.background = false
		this.publish(undefined)
	}
}
