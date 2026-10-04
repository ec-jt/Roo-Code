import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	getCurrentTask(): Task | undefined
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem }>
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		childInstanceId: string
		completionResultSummary: string
	}): Promise<void>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const
	private readonly returningChildren = new WeakSet<Task>()
	private readonly returnedChildren = new WeakSet<Task>()

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		const { result } = params
		const { handleError, pushToolResult } = callbacks
		if (this.returningChildren.has(task) || this.returnedChildren.has(task)) return

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			task.consecutiveMistakeCount = 0

			await task.say("completion_result", result, undefined, false)

			// Completed children reopened for inspection retain ordinary completion behavior.
			// All other children must return through the validated provider path, never
			// silently report standalone success after an unreadable or invalid history.
			if (task.parentTaskId) {
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (!provider)
					throw new Error("Cannot return subtask: provider unavailable. Reopen the child and retry.")
				const { historyItem } = await provider.getTaskWithId(task.taskId)
				if (this.returningChildren.has(task) || this.returnedChildren.has(task)) return
				if (
					provider.getCurrentTask() !== task ||
					task.abort ||
					task.abandoned ||
					task.modelOperationDispatchClosed
				)
					throw new Error("Cannot return subtask: task instance changed or dispatch closed.")
				if (historyItem.status !== "completed") {
					await task.assertCanDelegate()
					if (this.returningChildren.has(task) || this.returnedChildren.has(task)) return
					this.returningChildren.add(task)
					try {
						await provider.reopenParentFromDelegation({
							parentTaskId: task.parentTaskId,
							childTaskId: task.taskId,
							childInstanceId: task.instanceId,
							completionResultSummary: result,
						})
						this.returnedChildren.add(task)
						pushToolResult("")
					} finally {
						this.returningChildren.delete(task)
					}
					return
				}
			}

			const { response, text, images } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				this.emitTaskCompleted(task)
				return
			}

			// User provided feedback - push tool result to continue the conversation
			await task.say("user_feedback", text ?? "", images)

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError(
				"completing task or returning subtask (reopen the child and retry if interrupted)",
				error as Error,
			)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	private emitTaskCompleted(task: Task): void {
		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()
		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
