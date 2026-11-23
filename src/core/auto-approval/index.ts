import {
	type ClineAsk,
	type ClineSayTool,
	type McpServerUse,
	type FollowUpData,
	type ExtensionState,
	isNonBlockingAsk,
	isIdleAsk,
	isResumableAsk,
} from "@roo-code/types"

import { ClineAskResponse } from "../../shared/WebviewMessage"

import { isWriteToolAction, isReadOnlyToolAction } from "./tools"
import { isMcpToolAlwaysAllowed } from "./mcp"
import { getCommandDecision } from "./commands"

// We have auto-approval actions for different categories.
export type AutoApprovalState =
	| "alwaysAllowAll"
	| "alwaysAllowReadOnly"
	| "alwaysAllowWrite"
	| "alwaysAllowBrowser"
	| "alwaysAllowComputerUse"
	| "alwaysAllowMcp"
	| "alwaysAllowModeSwitch"
	| "alwaysAllowSubtasks"
	| "alwaysAllowExecute"
	| "alwaysAllowManagedEnvironments"
	| "alwaysAllowFollowupQuestions"

// Some of these actions have additional settings associated with them.
export type AutoApprovalStateOptions =
	| "autoApprovalEnabled"
	| "managedEnvironmentsEnabled"
	| "memoryEnabledForCurrentProject"
	| "alwaysAllowReadOnlyOutsideWorkspace" // For `alwaysAllowReadOnly`.
	| "alwaysAllowWriteOutsideWorkspace" // For `alwaysAllowWrite`.
	| "alwaysAllowWriteProtected"
	| "followupAutoApproveTimeoutMs" // For `alwaysAllowFollowupQuestions`.
	| "mcpServers" // For `alwaysAllowMcp`.
	| "allowedCommands" // For `alwaysAllowExecute`.
	| "deniedCommands"

export type CheckAutoApprovalResult =
	| { decision: "approve" }
	| { decision: "deny" }
	| { decision: "ask" }
	| {
			decision: "timeout"
			timeout: number
			fn: () => { askResponse: ClineAskResponse; text?: string; images?: string[] }
	  }

export async function checkAutoApproval({
	state,
	ask,
	text,
	isProtected,
	requiresToolApproval,
}: {
	state?: Pick<ExtensionState, AutoApprovalState | AutoApprovalStateOptions>
	ask: ClineAsk
	text?: string
	isProtected?: boolean
	requiresToolApproval?: boolean
}): Promise<CheckAutoApprovalResult> {
	// Task-local mandatory approval takes precedence over every automatic path.
	if (requiresToolApproval) {
		return { decision: "ask" }
	}

	if (isNonBlockingAsk(ask)) {
		return { decision: "approve" }
	}

	// Plan review is a user decision. It is never auto-approved, including in all-actions mode.
	if (ask === "plan_review") {
		return { decision: "ask" }
	}

	// Project opt-in is a separate grant, independent of general auto approval.
	// Personal operations and malformed memory requests never inherit all-actions approval.
	if (ask === "tool") {
		try {
			const tool = JSON.parse(text || "{}") as ClineSayTool
			// Model task_state calls use the ordinary chat approval (docs/task-state.md). A read is
			// auto-approved only by the read-only category, a patch only by the write category, and only
			// while auto-approval is on. Panel actions keep their native review and never come here.
			if (tool.tool === "taskState") {
				if (!state?.autoApprovalEnabled || isProtected) return { decision: "ask" }
				const action = tool.action
				if (action === "read") return { decision: state.alwaysAllowReadOnly === true ? "approve" : "ask" }
				if (action === "patch") return { decision: state.alwaysAllowWrite === true ? "approve" : "ask" }
				return { decision: "ask" }
			}
			if (tool.tool === "memory") {
				return {
					decision:
						state?.memoryEnabledForCurrentProject === true &&
						tool.path === "project" &&
						["list", "read", "upsert", "delete"].includes(tool.action ?? "") &&
						!isProtected
							? "approve"
							: "ask",
				}
			}
		} catch {
			return { decision: "ask" }
		}
	}

	if (!state || !state.autoApprovalEnabled) {
		return { decision: "ask" }
	}

	// Desktop control acts on the user's real screen, outside the workspace.
	// It is approved only by its own dedicated opt-in. It is checked before
	// alwaysAllowAll on purpose: "approve all actions" must not silently
	// extend to controlling other applications.
	if (ask === "computer_action") {
		return state.alwaysAllowComputerUse === true ? { decision: "approve" } : { decision: "ask" }
	}

	// Managed installs are a separate consent boundary, including in all-actions mode.
	if (ask === "tool") {
		try {
			const tool = JSON.parse(text || "{}") as ClineSayTool
			if (tool?.tool === "managedEnvironment") {
				if (state.managedEnvironmentsEnabled !== true || isProtected) return { decision: "ask" }
				if (tool.action === "install") {
					return { decision: state.alwaysAllowManagedEnvironments === true ? "approve" : "ask" }
				}
				if (tool.action === "prepare" || tool.action === "status") {
					return { decision: state.alwaysAllowReadOnly === true ? "approve" : "ask" }
				}
				return { decision: "ask" }
			}
		} catch {
			return { decision: "ask" }
		}
	}

	// Explicit opt-in for trusted, unattended environments. This preserves the
	// master auto-approval gate and intentionally bypasses category restrictions.
	// It must never auto-approve idle/resumable asks: those are how the task loop
	// pauses and terminates (task completion, API failure, resume, mistake limit,
	// auto-approval request limit). Approving them makes the task loop forever.
	// Follow-up questions are honored separately below so users can keep manual
	// control over clarifying questions even in all-actions mode.
	if (state.alwaysAllowAll === true && ask !== "followup" && !isIdleAsk(ask) && !isResumableAsk(ask)) {
		return { decision: "approve" }
	}

	if (ask === "followup") {
		if (state.alwaysAllowFollowupQuestions === true) {
			try {
				const suggestion = (JSON.parse(text || "{}") as FollowUpData).suggest?.[0]

				if (
					suggestion &&
					typeof state.followupAutoApproveTimeoutMs === "number" &&
					state.followupAutoApproveTimeoutMs > 0
				) {
					return {
						decision: "timeout",
						timeout: state.followupAutoApproveTimeoutMs,
						fn: () => ({ askResponse: "messageResponse", text: suggestion.answer }),
					}
				} else {
					return { decision: "ask" }
				}
			} catch (error) {
				return { decision: "ask" }
			}
		} else {
			return { decision: "ask" }
		}
	}

	if (ask === "use_mcp_server") {
		if (!text) {
			return { decision: "ask" }
		}

		try {
			const mcpServerUse = JSON.parse(text) as McpServerUse

			if (mcpServerUse.type === "use_mcp_tool") {
				return state.alwaysAllowMcp === true && isMcpToolAlwaysAllowed(mcpServerUse, state.mcpServers)
					? { decision: "approve" }
					: { decision: "ask" }
			} else if (mcpServerUse.type === "access_mcp_resource") {
				return state.alwaysAllowMcp === true ? { decision: "approve" } : { decision: "ask" }
			}
		} catch (error) {
			return { decision: "ask" }
		}

		return { decision: "ask" }
	}

	if (ask === "browser_action_launch") {
		if (state.alwaysAllowBrowser === true) {
			return { decision: "approve" }
		}
		return { decision: "ask" }
	}

	if (ask === "command") {
		if (!text) {
			return { decision: "ask" }
		}

		if (state.alwaysAllowExecute === true) {
			const decision = getCommandDecision(text, state.allowedCommands || [], state.deniedCommands || [])

			if (decision === "auto_approve") {
				return { decision: "approve" }
			} else if (decision === "auto_deny") {
				return { decision: "deny" }
			} else {
				return { decision: "ask" }
			}
		}
	}

	if (ask === "tool") {
		let tool: ClineSayTool | undefined

		try {
			tool = JSON.parse(text || "{}")
		} catch (error) {
			console.error("Failed to parse tool:", error)
		}

		if (!tool) {
			return { decision: "ask" }
		}

		if (tool.tool === "updateTodoList") {
			return { decision: "approve" }
		}

		// The skill tool only loads pre-defined instructions from global or project skills.
		// It does not read arbitrary files - skills must be explicitly installed/defined by the user.
		// Auto-approval is intentional to provide a seamless experience when loading task instructions.
		if (tool.tool === "skill") {
			return { decision: "approve" }
		}

		if (tool?.tool === "switchMode") {
			return state.alwaysAllowModeSwitch === true ? { decision: "approve" } : { decision: "ask" }
		}

		// newTasks (parallel subtasks) uses exactly the new_task rule; it never gets a wider path (Q-SEC-3).
		if (["newTask", "newTasks", "finishTask"].includes(tool?.tool)) {
			return state.alwaysAllowSubtasks === true ? { decision: "approve" } : { decision: "ask" }
		}

		const isOutsideWorkspace = !!tool.isOutsideWorkspace

		if (isReadOnlyToolAction(tool)) {
			return state.alwaysAllowReadOnly === true &&
				(!isOutsideWorkspace || state.alwaysAllowReadOnlyOutsideWorkspace === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}

		if (isWriteToolAction(tool)) {
			return state.alwaysAllowWrite === true &&
				(!isOutsideWorkspace || state.alwaysAllowWriteOutsideWorkspace === true) &&
				(!isProtected || state.alwaysAllowWriteProtected === true)
				? { decision: "approve" }
				: { decision: "ask" }
		}
	}

	return { decision: "ask" }
}

export { AutoApprovalHandler } from "./AutoApprovalHandler"
