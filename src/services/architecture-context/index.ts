import * as path from "path"
import * as vscode from "vscode"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ArchitectureContextMode } from "@roo-code/types"

import type { Task } from "../../core/task/Task"
import {
	buildArchitectureBody,
	findArchitectureRoot,
	isArchitectureContext,
	loadArchitectureRecords,
	renderArchitectureContext,
} from "./context"

export { isArchitectureContext } from "./context"

const notices = new WeakMap<Task, string>()

/** True when the latest retained architecture block differs from `context` (or none exists). */
export function needsArchitectureContext(context: string, history: Anthropic.Messages.MessageParam[]): boolean {
	if (!context) return false
	for (let i = history.length - 1; i >= 0; i--) {
		const content = history[i].content
		if (history[i].role !== "user" || !Array.isArray(content)) continue
		for (let j = content.length - 1; j >= 0; j--) {
			const block = content[j]
			if (block.type === "text" && isArchitectureContext(block.text)) return block.text !== context
		}
	}
	return true
}

/** Appends the block to new user content only when it changed; earlier messages are never touched. */
export function appendArchitectureContext(
	content: Anthropic.Messages.ContentBlockParam[],
	context: string,
	history: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.ContentBlockParam[] {
	const clean = content.filter((block) => block.type !== "text" || !isArchitectureContext(block.text))
	return needsArchitectureContext(context, history) ? [...clean, { type: "text", text: context }] : clean
}

async function notifyOnce(task: Task, notice: string) {
	if (notices.get(task) === notice) return
	notices.set(task, notice)
	await task.say("text", notice)
}

/**
 * Returns the architecture context block for the task, or "" when the mode is off, the workspace is
 * untrusted, there is no docs/architecture/arc42.md, or reading fails (one notice per task).
 */
export async function getArchitectureContext(task: Task, mode: ArchitectureContextMode | undefined): Promise<string> {
	if (!mode || mode === "off") return ""
	if (vscode.workspace.isTrusted !== true) return ""
	try {
		const root = await findArchitectureRoot(task.cwd)
		if (!root) return ""
		const records = await loadArchitectureRecords(root)
		let filesRead: string[] = []
		if (mode === "full") {
			const absolute = (await task.fileContextTracker?.getFilesReadByRoo()) ?? []
			filesRead = absolute.map((file) =>
				(path.isAbsolute(file) ? path.relative(task.cwd, file) : file).split(path.sep).join("/"),
			)
		}
		return renderArchitectureContext(buildArchitectureBody(records, { mode, filesRead }))
	} catch {
		await notifyOnce(task, "Architecture context unavailable. Check docs/architecture/ for unreadable files.")
		return ""
	}
}
