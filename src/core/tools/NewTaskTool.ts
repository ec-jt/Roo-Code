import * as vscode from "vscode"

import { TodoItem } from "@roo-code/types"

import { Task } from "../task/Task"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import {
	formatIsolatedDelegation,
	isSubtaskWorkspaceEnabled,
	parseSubtaskWorkspace,
	planIsolatedWorkspace,
} from "./subtask-workspace"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
	reason?: string
	workspace?: string | null
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos, reason, workspace } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate required parameters.
			if (!mode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			const expectedRevision = provider.delegationRevision
			const state = await provider.getState()

			// Use Package.name (dynamic at build time) as the VSCode configuration namespace.
			// Supports multiple extension variants (e.g., stable/nightly) without hardcoded strings.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos if provided, otherwise use empty array
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			// The workspace choice exists only in a development host. Elsewhere every subtask is shared.
			const workspaceMode = isSubtaskWorkspaceEnabled(provider) ? parseSubtaskWorkspace(workspace) : "shared"
			if (workspaceMode === "isolated") {
				// Fail before approval when isolation is impossible. Never fall back to shared.
				try {
					await planIsolatedWorkspace(task.cwd)
				} catch (error) {
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Cannot create an isolated workspace: ${(error as Error)?.message ?? String(error)}. No subtask was created. Use workspace "shared" only if the subtask does not need isolation.`,
						),
					)
					return
				}
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
				...(workspaceMode === "isolated" ? { workspace: workspaceMode } : {}),
			})

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			// Capture the approval message timestamp before delegation. The parent
			// history records it against the child ID so the UI can resolve this
			// exact new_task row instead of relying on childIds array order.
			const newTaskMessageTs = task.lastMessageTs

			// Delegate parent and open child as sole active task. Closing the parent instance here
			// does not end the parent task, so it must not be recorded as a stop (evaluation recording).
			task.evaluationRecorder?.suspendStops(true)
			let child: Awaited<ReturnType<typeof provider.delegateParentAndOpenChild>>
			try {
				child = await provider.delegateParentAndOpenChild({
					parentTaskId: task.taskId,
					parentInstanceId: task.instanceId,
					expectedRevision,
					message: unescapedMessage,
					initialTodos: todoItems,
					mode,
					reason,
					newTaskMessageTs,
					...(workspaceMode === "isolated" ? { workspace: workspaceMode } : {}),
				})
			} finally {
				task.evaluationRecorder?.suspendStops(false)
			}

			// Reflect delegation in tool result (no pause/unpause, no wait)
			pushToolResult(
				child.subtaskWorkspace
					? formatIsolatedDelegation(child.taskId, child.subtaskWorkspace)
					: `Delegated to child task ${child.taskId}`,
			)
			return
		} catch (error) {
			await handleError("creating new task", error)
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_task">): Promise<void> {
		const mode: string | undefined = block.params.mode
		const message: string | undefined = block.params.message
		const todos: string | undefined = block.params.todos
		const isolated =
			isSubtaskWorkspaceEnabled(task.providerRef.deref()) &&
			parseSubtaskWorkspace((block.nativeArgs as { workspace?: unknown } | undefined)?.workspace) === "isolated"

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
			...(isolated ? { workspace: "isolated" } : {}),
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
