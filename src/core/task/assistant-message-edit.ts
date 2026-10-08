import type { AssistantMessageEdit, ClineMessage } from "@roo-code/types"
import type { ApiMessage } from "../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../condense"
import * as path from "path"
import * as fs from "fs/promises"
import { getStorageBasePath } from "../../utils/storage"
import { saveTaskSnapshot } from "../task-persistence/taskSaves"

const EDIT_MARKER = "assistant-edit-pending.json"

export async function beginAssistantEdit(globalStoragePath: string, taskId: string): Promise<void> {
	await saveTaskSnapshot({ globalStoragePath, taskId, barrier: true }, EDIT_MARKER, () => ({ version: 1 }))
}

export async function finishAssistantEdit(globalStoragePath: string, taskId: string): Promise<void> {
	await fs.unlink(path.join(await getStorageBasePath(globalStoragePath), "tasks", taskId, EDIT_MARKER))
}

export async function assertNoInterruptedAssistantEdit(globalStoragePath: string, taskId: string): Promise<void> {
	try {
		await fs.stat(path.join(await getStorageBasePath(globalStoragePath), "tasks", taskId, EDIT_MARKER))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
	throw new Error(
		"An interrupted assistant edit left history in an uncertain state. Restore the task history files before resuming.",
	)
}

const MAX_EDIT_LENGTH = 1_000_000

export function validateAssistantMessageEdit(value: unknown): asserts value is AssistantMessageEdit {
	if (!value || typeof value !== "object") throw new Error("Missing assistant edit payload.")
	const edit = value as Record<string, unknown>
	for (const key of ["operationId", "taskId", "instanceId"]) {
		if (typeof edit[key] !== "string" || !edit[key] || edit[key].length > 256)
			throw new Error("Invalid assistant edit identity.")
	}
	if (!Number.isSafeInteger(edit.ts) || (edit.ts as number) <= 0)
		throw new Error("Invalid assistant message timestamp.")
	for (const key of ["expectedText", "text"]) {
		if (typeof edit[key] !== "string" || edit[key].length > MAX_EDIT_LENGTH)
			throw new Error("Assistant edits must contain text of at most 1,000,000 characters.")
	}
	if (!(edit.text as string).trim()) throw new Error("Assistant text cannot be empty.")
}

/** Resolve exact text only. Never infer a substring, tool result, or transformed presentation. */
export function prepareAssistantMessageEdit(
	ui: ClineMessage[],
	api: ApiMessage[],
	edit: AssistantMessageEdit,
): { ui: ClineMessage[]; api: ApiMessage[]; message: ClineMessage } {
	const rows = ui.filter((message) => message.ts === edit.ts)
	const row = rows[0]
	if (rows.length !== 1 || ui[0] === row || row.type !== "say" || row.say !== "text" || row.partial)
		throw new Error("Only completed assistant text messages can be edited.")
	if (row.text !== edit.expectedText) throw new Error("The assistant message changed. Reopen the editor.")
	if (
		row.requestId &&
		ui.filter((message) => message.type === "say" && message.say === "text" && message.requestId === row.requestId)
			.length !== 1
	)
		throw new Error("The assistant response has multiple text rows and cannot be mapped safely.")
	const textMatches = (message: ApiMessage) =>
		typeof message.content === "string"
			? message.content === edit.expectedText
			: message.content.filter((block) => block.type === "text").length === 1 &&
				message.content.some((block) => block.type === "text" && block.text === edit.expectedText)
	const candidates = api.filter(
		(message) =>
			message.role === "assistant" &&
			(row.requestId ? message.requestId === row.requestId : textMatches(message)),
	)
	const target = candidates[0]
	if (candidates.length !== 1 || !textMatches(target))
		throw new Error("The assistant text cannot be mapped unambiguously to model history.")
	// Legacy rows have no dispatch identity. Require unique text on both sides and timestamp order.
	if (
		!row.requestId &&
		(target.requestId ||
			!target.ts ||
			target.ts < row.ts ||
			ui.filter(
				(message) => message.type === "say" && message.say === "text" && message.text === edit.expectedText,
			).length !== 1)
	)
		throw new Error("This legacy assistant message cannot be mapped safely.")
	if (
		target.isSummary ||
		target.isTruncationMarker ||
		target.condenseParent ||
		target.truncationParent ||
		!getEffectiveApiHistory(api).includes(target)
	)
		throw new Error("Condensed or truncated assistant history cannot be edited.")
	const index = api.indexOf(target)
	const updated = { ...row, text: edit.text }
	return {
		message: updated,
		ui: ui.map((message) => (message === row ? updated : message)),
		api: api.map((message, i) => {
			if (i < index) return message
			const copy = { ...message }
			// Top-level assistant IDs identify server responses, not tool calls or reasoning items.
			if (copy.role === "assistant" && copy.type !== "reasoning") delete copy.id
			if (message === target)
				copy.content =
					typeof message.content === "string"
						? edit.text
						: message.content.map((block) =>
								block.type === "text" ? { ...block, text: edit.text } : block,
							)
			return copy
		}),
	}
}
