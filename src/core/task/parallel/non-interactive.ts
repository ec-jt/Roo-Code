/**
 * No-asking policy for parallel children (ADR-2026-11-22-parallel-subtasks rule 3, Q-SEC-3).
 *
 * A child cannot ask the user. The policy hooks in at ONE place: `Task.askAndWait`, after the existing
 * `checkAutoApproval` decision. When that decision is "approve", nothing changes: the child behaves
 * exactly like a normal task. For every other decision, this module answers the ask at once:
 * - `completion_result` is accepted, so the child finishes and records `completed`;
 * - approvals, follow-ups, plan reviews and anything else are refused with REFUSAL_MESSAGE;
 * - terminal prompts (failed request, mistake limit, resume) stop the child.
 * The policy only ever narrows: it never turns a decision into an approval, except accepting the
 * child's own completion, which grants no tool or capability.
 *
 * A capability policy additionally denies tools that would act on the user-facing provider
 * (`new_task`, `new_tasks`, `switch_mode`), even when auto-approval would allow them.
 */

import * as path from "path"

import type { ClineAsk } from "@roo-code/types"

import type { ClineAskResponse } from "../../../shared/WebviewMessage"
import type { ToolInvocationPolicy } from "../../tool-execution/invocation-policy"
import { isPathInsideRealRoot } from "../../../utils/containedPath"

/** Model-facing text. Needs no locale (C-7). */
export const PARALLEL_REFUSAL_MESSAGE =
	"Not approved: this subtask runs in parallel and cannot ask the user. Continue without it, and list what needs approval in your final result."

/** Tools a parallel child may never run: they would delegate or change the user-facing task or mode. */
export const PARALLEL_CHILD_DENIED_TOOLS: readonly string[] = ["new_task", "new_tasks", "switch_mode"]

/** Asks that end the child: nobody can retry, resume or confirm them. */
const TERMINAL_ASKS: ReadonlySet<ClineAsk> = new Set<ClineAsk>([
	"api_req_failed",
	"mistake_limit_reached",
	"auto_approval_max_req_reached",
	"resume_task",
	"resume_completed_task",
])

export interface RefusedApproval {
	/** Ask type ("tool", "command", "followup", ...) or "capability" for a denied tool. */
	type: string
	/** Tool name when known. */
	tool?: string
	/** Short, single-line description (truncated). */
	detail?: string
}

export interface NonInteractiveAnswer {
	response: ClineAskResponse
	text?: string
}

/** The hook a non-interactive Task calls instead of waiting for the user. */
export interface NonInteractiveTaskHooks {
	answerAsk(type: ClineAsk, text?: string): NonInteractiveAnswer
}

const DETAIL_LIMIT = 200

function oneLine(value: string | undefined): string | undefined {
	if (!value) return undefined
	const line = value.replace(/\s+/g, " ").trim()
	return line.length > DETAIL_LIMIT ? `${line.slice(0, DETAIL_LIMIT)}...` : line || undefined
}

/** Tool name and a short detail from an ask payload. Never throws. */
export function describeAsk(type: ClineAsk, text: string | undefined): RefusedApproval {
	if (type === "tool" || type === "use_mcp_server") {
		try {
			const parsed = JSON.parse(text || "{}") as Record<string, unknown>
			const tool =
				typeof parsed.tool === "string"
					? parsed.tool
					: typeof parsed.toolName === "string"
						? parsed.toolName
						: typeof parsed.type === "string"
							? parsed.type
							: undefined
			const target =
				typeof parsed.path === "string"
					? parsed.path
					: typeof parsed.serverName === "string"
						? parsed.serverName
						: typeof parsed.mode === "string"
							? parsed.mode
							: undefined
			return { type, tool, detail: oneLine(target) }
		} catch {
			return { type }
		}
	}
	if (type === "followup") {
		try {
			const parsed = JSON.parse(text || "{}") as { question?: unknown }
			return { type, detail: oneLine(typeof parsed.question === "string" ? parsed.question : text) }
		} catch {
			return { type, detail: oneLine(text) }
		}
	}
	return { type, detail: oneLine(text) }
}

export interface NonInteractiveDecision extends NonInteractiveAnswer {
	/** The ask was a request for approval or input and was refused. */
	refused?: RefusedApproval
	/** The ask ends the child. */
	stop?: ClineAsk
}

/** Pure decision for an ask that auto-approval did not approve. */
export function decideNonInteractiveAsk(type: ClineAsk, text: string | undefined): NonInteractiveDecision {
	if (type === "completion_result") return { response: "yesButtonClicked" }
	if (TERMINAL_ASKS.has(type)) return { response: "noButtonClicked", stop: type }
	return { response: "noButtonClicked", text: PARALLEL_REFUSAL_MESSAGE, refused: describeAsk(type, text) }
}

/** Refusal type recorded for a change outside the child's worktree. */
export const OUTSIDE_WORKTREE_REFUSAL = "outside-worktree"

/** The worktree a parallel child is confined to, and the folder its relative paths resolve against. */
export interface ParallelChildConfinement {
	/** Root of the child's git worktree. */
	worktreePath: string
	/** The child's cwd (the worktree root, or the matching sub-folder). */
	cwd: string
}

/** Built-in tools that change files, with the arguments that name the target. */
const PATH_ARGUMENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
	write_to_file: ["path"],
	apply_diff: ["path"],
	edit: ["file_path"],
	search_and_replace: ["file_path"],
	search_replace: ["file_path"],
	edit_file: ["file_path"],
	// Output files of the media tools. Their input image is only read.
	generate_image: ["path"],
	generate_video: ["path"],
}

/** Every target of an apply_patch body: added, deleted and updated files, and move destinations. */
const PATCH_TARGET = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/gm

/** Tools covered by the write confinement (for documentation and tests). */
export const PARALLEL_CHILD_CONFINED_TOOLS: readonly string[] = [
	...Object.keys(PATH_ARGUMENT_TOOLS),
	"apply_patch",
	"execute_command",
]

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key]
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** Model-facing refusal text for a path outside the worktree. Needs no locale (C-7). */
export function outsideWorktreeMessage(worktreePath: string, target: string, command = false): string {
	return command
		? `Parallel subtasks may only run commands inside their worktree ${worktreePath}. The working directory ${target} is outside it.`
		: `Parallel subtasks may only change files inside their worktree ${worktreePath}. ${target} is outside it.`
}

export interface ConfinementViolation {
	/** The target as the model gave it. */
	target: string
	/** Model-facing refusal text. */
	message: string
}

/**
 * Write confinement for a parallel child (ADR-2026-11-22-parallel-subtasks decision 1).
 * Returns the first target of a file-changing tool, or the cwd of a command, whose real path is not
 * inside the worktree. Symbolic links and `..` are resolved (see resolveRealPath). Other tools, and
 * calls without a target, return undefined: their own validation handles missing arguments.
 * Pure apart from file-system reads. Never throws.
 */
export function checkParallelChildConfinement(
	toolName: string,
	args: unknown,
	confinement: ParallelChildConfinement,
): ConfinementViolation | undefined {
	if (!args || typeof args !== "object") return undefined
	const record = args as Record<string, unknown>
	const inside = (target: string) =>
		isPathInsideRealRoot(path.resolve(confinement.cwd, target), confinement.worktreePath)

	if (toolName === "execute_command") {
		const cwd = stringArg(record, "cwd")
		if (cwd && !inside(cwd))
			return { target: cwd, message: outsideWorktreeMessage(confinement.worktreePath, cwd, true) }
		return undefined
	}

	const targets: string[] = []
	if (toolName === "apply_patch") {
		const patch = stringArg(record, "patch")
		if (patch) for (const match of patch.matchAll(PATCH_TARGET)) targets.push(match[1].trim())
	} else {
		for (const key of PATH_ARGUMENT_TOOLS[toolName] ?? []) {
			const value = stringArg(record, key)
			if (value) targets.push(value)
		}
	}
	for (const target of targets) {
		if (target && !inside(target))
			return { target, message: outsideWorktreeMessage(confinement.worktreePath, target) }
	}
	return undefined
}

/**
 * Capability policy for a parallel child. Denies the tools in PARALLEL_CHILD_DENIED_TOOLS, and, when a
 * confinement is given, every file change or command outside the child's worktree. It runs before any
 * approval check and only ever refuses (Q-SEC-3). Everything else still goes through the ordinary
 * validation and approval paths.
 */
export function parallelChildToolPolicy(
	onDenied: (refused: RefusedApproval) => void,
	confinement?: ParallelChildConfinement,
): ToolInvocationPolicy {
	return {
		evaluate: ({ identity, args }) => {
			const name = identity.kind === "mcp" ? undefined : identity.name
			if (name && PARALLEL_CHILD_DENIED_TOOLS.includes(name)) {
				onDenied({ type: "capability", tool: name })
				return { allow: false, reason: PARALLEL_REFUSAL_MESSAGE }
			}
			if (confinement && identity.kind === "builtin") {
				const violation = checkParallelChildConfinement(identity.name, args, confinement)
				if (violation) {
					onDenied({ type: OUTSIDE_WORKTREE_REFUSAL, tool: identity.name, detail: oneLine(violation.target) })
					return { allow: false, reason: violation.message }
				}
			}
			return { allow: true }
		},
	}
}
