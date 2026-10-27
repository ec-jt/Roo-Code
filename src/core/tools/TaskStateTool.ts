import type { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { isToolAllowedForMode } from "./validateToolUse"
import { taskStateArgsSchema } from "../prompts/tools/native-tools/task_state"
import { taskStatePatchOperationsSchema } from "../../../packages/types/src/task-state"
import { taskStateTransaction, recordTaskStateMilestone } from "../../services/task-state/taskState"
import { renderTaskState } from "../../services/task-state/render"
import { TaskStateError } from "../../services/task-state/types"

export class TaskStateTool extends BaseTool<"task_state"> {
	readonly name = "task_state" as const
	async execute(raw: NativeToolArgs["task_state"], task: Task, callbacks: ToolCallbacks) {
		try {
			const args = taskStateArgsSchema.parse(raw)
			const { store, options } = await taskStateTransaction(task, args.expected_revision)
			const check = async () => {
				await options.authorize()
				const state = await task.providerRef.deref()?.getState()
				if (
					!state ||
					state.disabledTools?.includes("task_state") ||
					!isToolAllowedForMode("task_state", state.mode ?? "code", state.customModes ?? [])
				)
					throw new TaskStateError("MODE", "Task state is unavailable in this mode")
				const current = await store.read(options.validHistoryAnchors)
				if (!current.snapshot || !current.policy.recallEnabled)
					throw new TaskStateError("DISABLED", "Task state must be enabled by the user")
				if (args.action === "patch" && current.revision !== args.expected_revision)
					throw new TaskStateError("CONFLICT", "Reread the current ledger revision")
				return current
			}
			await check()
			if (
				!(await callbacks.askApproval(
					"tool",
					JSON.stringify({ tool: "taskState", action: args.action, content: JSON.stringify(args) }),
				))
			)
				return
			let result = await check()
			if (args.action === "patch") {
				result = await store.patch({
					...options,
					authorize: async () => {
						await check()
					},
					operations: taskStatePatchOperationsSchema.parse(JSON.parse(args.operations!)),
				})
				await recordTaskStateMilestone(task)
				result = await store.read(options.validHistoryAnchors)
			}
			callbacks.pushToolResult(`Ledger revision: ${result.revision}\n${renderTaskState(result.snapshot)}`)
		} catch (error) {
			task.didToolFailInCurrentTurn = true
			callbacks.pushToolResult(
				error instanceof TaskStateError
					? `${error.code}: ${error.message}`
					: "Task state request failed validation or authorization.",
			)
		}
	}
}
export const taskStateTool = new TaskStateTool()
