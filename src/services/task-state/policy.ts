import type { TaskStateCompletionStatus, TaskStatePolicy } from "../../../packages/types/src/task-state"
import { taskStatePolicySchema } from "../../../packages/types/src/task-state"

export interface ContinuationInput {
	policy: TaskStatePolicy
	steps: number
	elapsedMs: number
	tokens: number
	noProgressSteps: number
	awaitingApproval: boolean
	blocked: boolean
	/** Native runtime observations for current history and the current policy only, never model assertions. */
	checks: ReadonlyArray<{ id: string; result: "passed" | "failed" | "pending"; provenance: "runtime_observed" }>
}
export interface ContinuationDecision {
	status: TaskStateCompletionStatus
	shouldContinue: boolean
	reason:
		| "disabled"
		| "approval"
		| "blocked"
		| "accepted"
		| "step-limit"
		| "time-limit"
		| "token-limit"
		| "no-progress"
		| "continue"
		| "invalid"
}

/** Pure gate only. It neither runs checks nor authorizes tools, commands, or approvals. */
export function evaluateContinuation(input: ContinuationInput): ContinuationDecision {
	const stop = (status: TaskStateCompletionStatus, reason: ContinuationDecision["reason"]): ContinuationDecision => ({
		status,
		shouldContinue: false,
		reason,
	})
	const parsed = taskStatePolicySchema.safeParse(input.policy)
	if (
		!parsed.success ||
		[input.steps, input.elapsedMs, input.tokens, input.noProgressSteps].some(
			(n) => !Number.isSafeInteger(n) || n < 0,
		)
	)
		return stop("incomplete", "invalid")
	const policy = parsed.data
	if (input.awaitingApproval) return stop("awaiting-approval", "approval")
	if (input.blocked) return stop("blocked", "blocked")
	if (
		new Set(policy.checks.map((check) => check.id)).size !== policy.checks.length ||
		new Set(input.checks.map((check) => check.id)).size !== input.checks.length
	)
		return stop("incomplete", "invalid")
	if (
		policy.checks.length > 0 &&
		policy.checks.every((check) =>
			input.checks.some(
				(result) =>
					result.id === check.id && result.result === "passed" && result.provenance === "runtime_observed",
			),
		)
	)
		return stop("completed", "accepted")
	if (!policy.enabled) return stop("incomplete", "disabled")
	if (input.steps >= policy.maxSteps) return stop("incomplete", "step-limit")
	if (input.elapsedMs >= policy.maxDurationMs) return stop("incomplete", "time-limit")
	if (input.tokens >= policy.maxTokens) return stop("incomplete", "token-limit")
	if (input.noProgressSteps >= policy.maxNoProgressSteps) return stop("incomplete", "no-progress")
	return { status: "incomplete", shouldContinue: true, reason: "continue" }
}
