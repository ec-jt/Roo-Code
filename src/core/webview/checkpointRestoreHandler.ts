import { Task } from "../task/Task"
import { ClineProvider } from "./ClineProvider"
import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import { t } from "../../i18n"

export interface CheckpointRestoreConfig {
	provider: ClineProvider
	currentCline: Task
	messageTs: number
	messageIndex: number
	checkpoint: { hash: string }
	operation: "delete" | "edit"
	editData?: {
		editedContent: string
		images?: string[]
		apiConversationHistoryIndex: number
	}
}

/**
 * Handles checkpoint restoration for both delete and edit operations.
 * This consolidates the common logic while handling operation-specific behavior.
 */
export async function handleCheckpointRestoreOperation(config: CheckpointRestoreConfig): Promise<void> {
	const { provider, messageTs, checkpoint, operation, editData } = config
	let currentCline = config.currentCline

	try {
		// Cancellation drains the old instance. Restore through its replacement,
		// never through an instance whose persistence has already been closed.
		if (provider.getCurrentTask() !== currentCline || provider.isChatWindowFollowing?.() === false) return
		await provider.cancelTask()
		if (!(await waitForClineInitialization(provider))) throw new Error("Task did not initialize for restore")
		const replacement = provider.getCurrentTask()
		if (!replacement || replacement.taskId !== currentCline.taskId || provider.isChatWindowFollowing?.() === false)
			throw new Error("Task changed during checkpoint restore")
		currentCline = replacement

		// For edit operations, set up pending edit data before restoration
		if (operation === "edit" && editData) {
			const operationId = `task-${currentCline.taskId}`
			provider.setPendingEditOperation(operationId, {
				messageTs,
				editedContent: editData.editedContent,
				images: editData.images,
				messageIndex: config.messageIndex,
				apiConversationHistoryIndex: editData.apiConversationHistoryIndex,
			})
		}

		// Perform the checkpoint restoration
		await currentCline.checkpointRestore({
			ts: messageTs,
			commitHash: checkpoint.hash,
			mode: "restore",
			operation,
		})

		// checkpointRestore persists its rewind and awaits reinitialization.
	} catch (error) {
		console.error(`Error in checkpoint restore (${operation}):`, error)
		vscode.window.showErrorMessage(
			`Error during checkpoint restore: ${error instanceof Error ? error.message : String(error)}`,
		)
		throw error
	}
}

/**
 * Common checkpoint restore validation and initialization utility.
 * This can be used by any checkpoint restore flow that needs to wait for initialization.
 */
export async function waitForClineInitialization(provider: ClineProvider, timeoutMs: number = 3000): Promise<boolean> {
	try {
		await pWaitFor(() => provider.getCurrentTask()?.isInitialized === true, {
			timeout: timeoutMs,
		})
		return true
	} catch (error) {
		vscode.window.showErrorMessage(t("common:errors.checkpoint_timeout"))
		return false
	}
}
