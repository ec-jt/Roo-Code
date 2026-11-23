import * as path from "path"
import * as vscode from "vscode"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ArchitectureContextMode } from "@roo-code/types"

import type { Task } from "../../core/task/Task"
import { extractCitedIds } from "../../shared/architecture-docs/parse"
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

const MAX_DELEGATED_IDS = 30

function textOf(content: Anthropic.Messages.MessageParam["content"]): string[] {
	if (typeof content === "string") return [content]
	return content.flatMap((block) => (block.type === "text" ? [block.text] : []))
}

/**
 * IDs to pass to a subtask: IDs present in the parent's latest architecture block that the parent
 * actually cited (in the delegation message, extra text such as the ledger, or its own assistant text).
 * Returns [] when there is no block or nothing was cited.
 */
export function architectureIdsInScope(
	history: Anthropic.Messages.MessageParam[],
	delegationMessage: string,
	extraText: string[] = [],
): string[] {
	let block: string | undefined
	const cited: string[] = [delegationMessage, ...extraText]
	for (let i = history.length - 1; i >= 0; i--) {
		for (const text of textOf(history[i].content)) {
			if (isArchitectureContext(text)) {
				block ??= text
			} else if (history[i].role === "assistant") {
				cited.push(text)
			}
		}
	}
	if (!block) return []
	const known = new Set(extractCitedIds(block))
	const inScope: string[] = []
	for (const id of extractCitedIds(cited.join("\n"))) {
		if (known.has(id) && !inScope.includes(id)) inScope.push(id)
		if (inScope.length >= MAX_DELEGATED_IDS) break
	}
	return inScope
}

async function notifyOnce(task: Task, notice: string) {
	if (notices.get(task) === notice) return
	notices.set(task, notice)
	await task.say("text", notice)
}

export interface ArchitectureContextSettings {
	architectureContextMode?: ArchitectureContextMode
	architectureDecisionApproval?: "user" | "agent"
	architectureBootstrap?: boolean
	autoApprovalEnabled?: boolean
}

export const BOOTSTRAP_INSTRUCTION =
	"No docs/architecture/ layout exists in this workspace. Before planning, survey the repository (manifests, entry points, directory structure, existing docs, AGENTS.md and rules files, tests, CI, recent history). Then create docs/architecture/arc42.md (an index of the 12 arc42 sections, each linking its owner document or marked not applicable), constraints.md, and only the records this plan needs. Record format: one `### <ID>: Title` heading per constraint (C-<n>), quality goal (Q-<AREA>-<n>) or risk (R-<n>); decisions as decisions/<status>/ADR-YYYY-MM-DD-<topic>.md with a `# <ID>: Title` heading. Each record has header lines `Status: proposed|accepted|rejected|superseded`, `Last-verified: YYYY-MM-DD`, and optional `Paths:`, `Source: inferred|reconstructed`; decisions have sections Problem, Proposal (Decision once accepted), Alternatives considered, Acceptance criteria and Risks (Consequences once accepted). Mark inferred content `Source: inferred` and leave it proposed. Report the created files to the user."

/** Fixed per task, so it never changes the block digest within a task. */
export function acceptancePolicyLine(settings: ArchitectureContextSettings, taskId: string): string {
	const agent = settings.architectureDecisionApproval === "agent" && settings.autoApprovalEnabled === true
	return agent
		? `Acceptance policy: agent. You may accept records and quality goals: move them to accepted and write \`Accepted-by: agent (task ${taskId})\`, and state each acceptance in chat. Never reject, supersede, or weaken accepted items without asking the user.`
		: "Acceptance policy: user. Leave new and changed records proposed and ask the user to accept them."
}

/**
 * Added to the bootstrap block for a task with the plan overlay on (`/plan` in cordis or hybrid), so
 * the plan's constraints exist as records that the drift rule can cite (L1 defect 2).
 */
export const PLAN_BOOTSTRAP_INSTRUCTION =
	"This task is in plan mode. Before calling exit_plan, record the key constraints and decisions of the plan as records in that layout (constraints as C-<n>, decisions as ADRs), including every requirement that limits later changes, such as rules about existing stored data. Cite their IDs in the plan."

/**
 * Returns the architecture context block for the task, or "" when the mode is off, the workspace is
 * untrusted, there is no docs/architecture/arc42.md, or reading fails (one notice per task).
 * Planning tasks (Architect mode, or the plan overlay on) also get the acceptance policy line, and a
 * bootstrap instruction when the layout is missing and bootstrap is enabled.
 */
export async function getArchitectureContext(
	task: Task,
	settings: ArchitectureContextSettings | undefined,
	taskMode?: string,
): Promise<string> {
	const mode = settings?.architectureContextMode
	if (!mode || mode === "off") return ""
	if (vscode.workspace.isTrusted !== true) return ""
	const planOverlay = task.planOverlay === true
	const isArchitect = taskMode === "architect" || planOverlay
	try {
		const root = await findArchitectureRoot(task.cwd)
		if (!root) {
			if (isArchitect && settings?.architectureBootstrap !== false) {
				const planLine = planOverlay ? `\n${PLAN_BOOTSTRAP_INSTRUCTION}` : ""
				return renderArchitectureContext(
					`${BOOTSTRAP_INSTRUCTION}${planLine}\n${acceptancePolicyLine(settings!, task.taskId)}`,
				)
			}
			return ""
		}
		const records = await loadArchitectureRecords(root)
		let filesRead: string[] = []
		if (mode === "full") {
			const absolute = (await task.fileContextTracker?.getFilesReadByRoo()) ?? []
			filesRead = absolute.map((file) =>
				(path.isAbsolute(file) ? path.relative(task.cwd, file) : file).split(path.sep).join("/"),
			)
		}
		const body = buildArchitectureBody(records, { mode, filesRead })
		return renderArchitectureContext(
			isArchitect ? `${body}\n${acceptancePolicyLine(settings!, task.taskId)}` : body,
		)
	} catch {
		await notifyOnce(task, "Architecture context unavailable. Check docs/architecture/ for unreadable files.")
		return ""
	}
}
