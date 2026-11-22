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

import type { ClineAsk } from "@roo-code/types"

import type { ClineAskResponse } from "../../../shared/WebviewMessage"
import type { ToolInvocationPolicy } from "../../tool-execution/invocation-policy"

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

/**
 * Capability policy for a parallel child. Denies the tools in PARALLEL_CHILD_DENIED_TOOLS and allows
 * everything else, which still goes through the ordinary validation and approval paths.
 */
export function parallelChildToolPolicy(onDenied: (refused: RefusedApproval) => void): ToolInvocationPolicy {
	return {
		evaluate: ({ identity }) => {
			const name = identity.kind === "mcp" ? undefined : identity.name
			if (name && PARALLEL_CHILD_DENIED_TOOLS.includes(name)) {
				onDenied({ type: "capability", tool: name })
				return { allow: false, reason: PARALLEL_REFUSAL_MESSAGE }
			}
			return { allow: true }
		},
	}
}
