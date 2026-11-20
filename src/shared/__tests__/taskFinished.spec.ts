import type { ClineMessage } from "@roo-code/types"

import { isTaskFinished } from "../taskFinished"

const ask = (ask: ClineMessage["ask"], extra: Partial<ClineMessage> = {}): ClineMessage =>
	({ ts: 1, type: "ask", ask, ...extra }) as ClineMessage
const say = (say: ClineMessage["say"]): ClineMessage => ({ ts: 1, type: "say", say }) as ClineMessage

describe("isTaskFinished", () => {
	it("is false without a task or messages", () => {
		expect(isTaskFinished(undefined)).toBe(false)
		expect(isTaskFinished({ clineMessages: [] })).toBe(false)
	})

	it("is true when the last message is a complete completion_result ask", () => {
		expect(isTaskFinished({ clineMessages: [say("completion_result"), ask("completion_result")] })).toBe(true)
	})

	it("ignores trailing resume asks of a reopened finished task", () => {
		expect(
			isTaskFinished({
				clineMessages: [ask("completion_result"), ask("resume_completed_task"), ask("resume_task")],
			}),
		).toBe(true)
	})

	it("is false when the completion ask is partial or only the completion say exists", () => {
		expect(isTaskFinished({ clineMessages: [ask("completion_result", { partial: true })] })).toBe(false)
		expect(isTaskFinished({ clineMessages: [say("completion_result")] })).toBe(false)
	})

	it.each(["followup", "tool", "command", "api_req_failed", "resume_task"] as const)(
		"is false for a task paused on %s",
		(type) => {
			expect(isTaskFinished({ clineMessages: [say("text"), ask(type)] })).toBe(false)
		},
	)

	it("is false once the user has answered the completion ask", () => {
		expect(isTaskFinished({ clineMessages: [ask("completion_result"), say("user_feedback")] })).toBe(false)
	})
})
