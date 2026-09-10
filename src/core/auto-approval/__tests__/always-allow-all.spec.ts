import { checkAutoApproval } from "../index"

const baseState = {
	autoApprovalEnabled: true,
	alwaysAllowAll: false,
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowBrowser: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowExecute: false,
	alwaysAllowFollowupQuestions: false,
} as const

describe("alwaysAllowAll", () => {
	it("approves any ask when alwaysAllowAll is true and auto-approval is enabled", async () => {
		const state = { ...baseState, alwaysAllowAll: true as const }

		expect(await checkAutoApproval({ state, ask: "command", text: "rm -rf /tmp/x" })).toEqual({
			decision: "approve",
		})
		expect(await checkAutoApproval({ state, ask: "browser_action_launch" })).toEqual({ decision: "approve" })
		expect(
			await checkAutoApproval({
				state,
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "s", toolName: "t" }),
			}),
		).toEqual({ decision: "approve" })
	})

	it("still requires the master autoApprovalEnabled gate", async () => {
		const state = { ...baseState, autoApprovalEnabled: false, alwaysAllowAll: true as const }

		expect(await checkAutoApproval({ state, ask: "command", text: "ls" })).toEqual({ decision: "ask" })
	})

	it("does not approve when alwaysAllowAll is false", async () => {
		const state = { ...baseState }

		expect(await checkAutoApproval({ state, ask: "browser_action_launch" })).toEqual({ decision: "ask" })
	})
})
