import type { ClineMessage } from "@roo-code/types"

/**
 * Minimal task shape needed to decide whether a task is finished. `Task`
 * satisfies it; tests may pass plain objects.
 */
export interface FinishedTaskProbe {
	clineMessages?: readonly ClineMessage[]
}

/**
 * The single rule for "the open task is finished" (used by profile delete,
 * profile selection and the `currentTaskFinished` webview state field).
 *
 * A task is finished when, ignoring trailing `resume_task` /
 * `resume_completed_task` asks (added when a task is reopened from history),
 * its last message is a complete (non-partial) `ask: "completion_result"`.
 * This is the same signal `Task.resumeTaskFromHistory` uses to choose
 * `resume_completed_task`. A complete trailing ask means the task is blocked
 * waiting for the user, so no request is in flight. (`Task.isStreaming` is
 * deliberately not used: `attempt_completion` asks while the stream loop may
 * still be unwinding, and the state posted with that ask must already say
 * "finished". The webview applies its own streaming guard.)
 *
 * Consequences:
 * - A task waiting on any other ask (followup, tool/command approval,
 *   `api_req_failed`, `resume_task` of an unfinished task, ...) is NOT finished.
 * - Once the user answers the completion ask (feedback or a new message), new
 *   messages follow it, so the task is no longer finished.
 *
 * A finished task keeps its saved provider profile: global profile changes
 * (delete or select) must not rewrite its `apiConfigName` or rebuild its API
 * handler for a different profile.
 */
export function isTaskFinished(task: FinishedTaskProbe | undefined): boolean {
	if (!task) return false
	const messages = task.clineMessages ?? []
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type === "ask" && (message.ask === "resume_completed_task" || message.ask === "resume_task")) {
			continue
		}
		return message.type === "ask" && message.ask === "completion_result" && message.partial !== true
	}
	return false
}
