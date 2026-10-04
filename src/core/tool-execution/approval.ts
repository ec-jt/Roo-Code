import type { ClineAsk, ToolProgressStatus } from "@roo-code/types"

export type AuthorizationAsk = Extract<ClineAsk, "tool" | "command" | "use_mcp_server" | "browser_action_launch">

export function isAuthorizationAsk(type: ClineAsk): type is AuthorizationAsk {
	return type === "tool" || type === "command" || type === "use_mcp_server" || type === "browser_action_launch"
}

export interface TaskApprovalRequest {
	readonly taskId: string
	readonly instanceId: string
	readonly sequence: number
	readonly type: AuthorizationAsk
	readonly text?: string
	readonly progressStatus?: ToolProgressStatus
	readonly isProtected?: boolean
}

export type TaskApprovalDecision = { decision: "continue" } | { decision: "deny"; reason?: string }

/**
 * A task-wide veto for authorization asks, including direct handler asks.
 * Continue means use the existing approval flow, NOT grant permission. This port
 * cannot override capabilities, mandatory branch approval, or auto-approval denials.
 * Display text is not an exact-action digest or a canonical resource binding.
 */
export interface TaskApprovalPort {
	check(request: TaskApprovalRequest): TaskApprovalDecision | Promise<TaskApprovalDecision>
}
