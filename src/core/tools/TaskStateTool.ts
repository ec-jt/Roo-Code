import type { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { isToolAllowedForMode } from "./validateToolUse"
import {
	taskStateArgsSchema,
	normalizeTaskStateArgs,
	TASK_STATE_REVISION_REQUIRED,
} from "../prompts/tools/native-tools/task_state"
import { taskStatePatchOperationsSchema } from "../../../packages/types/src/task-state"
import { taskStateTransaction, recordTaskStateMilestone } from "../../services/task-state/taskState"
import { renderTaskState } from "../../services/task-state/render"
import { TaskStateError } from "../../services/task-state/types"

export const TASK_STATE_DISABLED_GUIDANCE =
	'Task state must be enabled by the user. Ask the user to enable task state in the task panel ("Task state" below the task header, then "Enable task state"); it can be enabled at any time, including while a question is pending. Until then, continue without task_state (for example, use the todo list).'

export class TaskStateTool extends BaseTool<"task_state"> {
	readonly name = "task_state" as const
	async execute(raw: NativeToolArgs["task_state"], task: Task, callbacks: ToolCallbacks) {
		try {
			const normalized = normalizeTaskStateArgs(raw) as Record<string, unknown>
			// Guidance, not a schema failure: patch must never run without the revision check.
			if (normalized?.action === "patch" && normalized.expected_revision === null)
				throw new TaskStateError("REVISION_REQUIRED", TASK_STATE_REVISION_REQUIRED)
			const args = taskStateArgsSchema.parse(normalized)
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
					throw new TaskStateError("DISABLED", TASK_STATE_DISABLED_GUIDANCE)
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
			// DISABLED is a user-controlled state, not a model mistake: it never counts toward the mistake
			// limit and does not block attempt_completion in this turn.
			if (!(error instanceof TaskStateError && error.code === "DISABLED")) task.didToolFailInCurrentTurn = true
			callbacks.pushToolResult(
				error instanceof TaskStateError
					? `${error.code}: ${error.message}`
					: "Task state request failed validation or authorization.",
			)
		}
	}
}
export const taskStateTool = new TaskStateTool()
