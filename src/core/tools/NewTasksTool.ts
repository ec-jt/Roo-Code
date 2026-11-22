import { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { clampConcurrency, normalizeTokenBudget } from "../task/parallel/BatchAdmissionRuntime"
import { formatParallelBatchResult } from "../task/parallel/ParallelTaskPool"

/** Children per `new_tasks` call. The pool itself accepts 1 to 4; the tool asks for real parallelism. */
export const MIN_NEW_TASKS = 2
export const MAX_NEW_TASKS = 4

interface NewTasksParams {
	tasks: Array<{ mode: string; message: string }>
}

/**
 * `new_tasks` (ADR-2026-11-22-parallel-subtasks rules 1 and 5).
 *
 * One approval for the whole batch, with the `newTasks` payload. Auto-approval uses the same rule as
 * `new_task` (`alwaysAllowSubtasks`, see core/auto-approval). It is never weaker than `new_task`:
 * - only the current, non-child (depth 0) task can start a batch; a depth-1 task must use `new_task`
 *   with a reason, which keeps the nested-delegation approval fence;
 * - a model-operation branch or closed task cannot start a batch (Task.assertCanDelegate);
 * - a parallel child never reaches this tool (schema filter and capability policy).
 * After approval: startBatch, waitForBatch, then one formatted tool result. Nothing is merged.
 */
export class NewTasksTool extends BaseTool<"new_tasks"> {
	readonly name = "new_tasks" as const

	async execute(params: NewTasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const fail = (message: string, mistake = true) => {
			if (mistake) task.consecutiveMistakeCount++
			task.recordToolError("new_tasks")
			task.didToolFailInCurrentTurn = true
			pushToolResult(formatResponse.toolError(message))
		}

		try {
			const provider = task.providerRef.deref()
			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// Validate the arguments before anything is shown or started.
			const tasks = params?.tasks
			if (!Array.isArray(tasks) || tasks.length < MIN_NEW_TASKS || tasks.length > MAX_NEW_TASKS) {
				fail(`new_tasks takes ${MIN_NEW_TASKS} to ${MAX_NEW_TASKS} tasks. No subtask was started.`)
				return
			}
			const state = await provider.getState()
			const children: Array<{ mode: string; message: string }> = []
			for (const [index, entry] of tasks.entries()) {
				const mode = typeof entry?.mode === "string" ? entry.mode.trim() : ""
				const message = typeof entry?.message === "string" ? entry.message : ""
				if (!mode || !getModeBySlug(mode, state?.customModes)) {
					fail(`Task ${index + 1}: unknown mode "${mode}". No subtask was started.`)
					return
				}
				if (!message.trim()) {
					fail(`Task ${index + 1}: the message is empty. No subtask was started.`)
					return
				}
				children.push({ mode, message: message.replace(/\\\\@/g, "\\@") })
			}

			// Never a weaker path than new_task (Q-SEC-3).
			if (task.nonInteractive) {
				fail("A parallel subtask cannot start parallel subtasks.", false)
				return
			}
			if (task.parentTaskId) {
				fail(
					"Parallel subtasks can only be started by a root task (depth 0). Execute directly, or use new_task with a concrete reason.",
					false,
				)
				return
			}
			if (provider.getCurrentTask() !== task) {
				fail("Parallel subtasks can only be started by the current task.", false)
				return
			}
			try {
				await task.assertCanDelegate()
			} catch (error) {
				fail((error as Error)?.message ?? String(error), false)
				return
			}

			task.consecutiveMistakeCount = 0

			// The approved values are the values the batch runs with.
			const concurrency = clampConcurrency(state?.parallelSubtasksConcurrency)
			const tokenBudget = normalizeTokenBudget(state?.parallelSubtasksTokenBudget)

			const didApprove = await askApproval(
				"tool",
				JSON.stringify({ tool: "newTasks", tasks: children, concurrency, tokenBudget }),
			)
			if (!didApprove) return

			const pool = provider.parallelTaskPool
			let batchId: string
			try {
				batchId = await pool.startBatch({ parent: task, children, concurrency, tokenBudget })
			} catch (error) {
				fail(
					`Cannot start parallel subtasks: ${(error as Error)?.message ?? String(error)}. No subtask was started.`,
					false,
				)
				return
			}

			// Stopping the parent stops the batch (pool listens for TaskAborted), so this always settles.
			const result = await pool.waitForBatch(batchId)
			if (task.abort || task.abandoned) return
			pushToolResult(formatParallelBatchResult(result))
		} catch (error) {
			await handleError("starting parallel subtasks", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_tasks">): Promise<void> {
		const tasks = Array.isArray(block.nativeArgs?.tasks) ? block.nativeArgs.tasks : []
		const partialMessage = JSON.stringify({
			tool: "newTasks",
			tasks: tasks.map((entry) => ({
				mode: typeof entry?.mode === "string" ? entry.mode : "",
				message: typeof entry?.message === "string" ? entry.message : "",
			})),
		})
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTasksTool = new NewTasksTool()
