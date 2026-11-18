import { checkAutoApproval } from "../index"

const baseState = {
	autoApprovalEnabled: true,
	alwaysAllowAll: false,
	alwaysAllowReadOnly: false,
	alwaysAllowWrite: false,
	alwaysAllowBrowser: false,
	alwaysAllowComputerUse: false,
	alwaysAllowMcp: false,
	alwaysAllowModeSwitch: false,
	alwaysAllowSubtasks: false,
	alwaysAllowExecute: false,
	alwaysAllowFollowupQuestions: false,
} as const

const click = JSON.stringify({ action: "click", coordinate: "10,20" })

describe("computer_action auto-approval", () => {
	it("asks by default", async () => {
		expect(await checkAutoApproval({ state: baseState, ask: "computer_action", text: click })).toEqual({
			decision: "ask",
		})
	})

	it("approves every action when alwaysAllowComputerUse is on", async () => {
		const state = { ...baseState, alwaysAllowComputerUse: true }
		for (const action of ["screenshot", "click", "type", "key", "drag", "focus_window"]) {
			expect(
				await checkAutoApproval({ state, ask: "computer_action", text: JSON.stringify({ action }) }),
			).toEqual({ decision: "approve" })
		}
	})

	it("treats a batch payload like a single action", async () => {
		const batch = JSON.stringify({
			steps: [
				{ action: "click", coordinate: "1,1" },
				{ action: "type", text: "hi", submit: true },
			],
		})
		expect(await checkAutoApproval({ state: baseState, ask: "computer_action", text: batch })).toEqual({
			decision: "ask",
		})
		expect(
			await checkAutoApproval({
				state: { ...baseState, alwaysAllowComputerUse: true },
				ask: "computer_action",
				text: batch,
			}),
		).toEqual({ decision: "approve" })
		expect(
			await checkAutoApproval({
				state: { ...baseState, alwaysAllowAll: true },
				ask: "computer_action",
				text: batch,
			}),
		).toEqual({ decision: "ask" })
	})

	it("is NOT approved by alwaysAllowAll alone", async () => {
		const state = { ...baseState, alwaysAllowAll: true }
		expect(await checkAutoApproval({ state, ask: "computer_action", text: click })).toEqual({ decision: "ask" })
	})

	it("is not approved by other category toggles", async () => {
		const state = {
			...baseState,
			alwaysAllowBrowser: true,
			alwaysAllowExecute: true,
			alwaysAllowWrite: true,
			alwaysAllowReadOnly: true,
			alwaysAllowMcp: true,
		}
		expect(await checkAutoApproval({ state, ask: "computer_action", text: click })).toEqual({ decision: "ask" })
	})

	it("still requires the master autoApprovalEnabled gate", async () => {
		const state = { ...baseState, autoApprovalEnabled: false, alwaysAllowComputerUse: true }
		expect(await checkAutoApproval({ state, ask: "computer_action", text: click })).toEqual({ decision: "ask" })
	})

	it("does not change alwaysAllowAll behaviour for other asks", async () => {
		const state = { ...baseState, alwaysAllowAll: true }
		expect(await checkAutoApproval({ state, ask: "browser_action_launch" })).toEqual({ decision: "approve" })
	})
})
