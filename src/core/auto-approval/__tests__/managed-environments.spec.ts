import { checkAutoApproval } from "../index"

const state = {
	autoApprovalEnabled: true,
	alwaysAllowAll: true,
	alwaysAllowReadOnly: true,
	alwaysAllowWrite: true,
	alwaysAllowExecute: true,
	alwaysAllowBrowser: true,
	alwaysAllowMcp: true,
	alwaysAllowModeSwitch: true,
	alwaysAllowSubtasks: true,
	alwaysAllowFollowupQuestions: true,
	managedEnvironmentsEnabled: true,
	alwaysAllowManagedEnvironments: false,
}
const text = JSON.stringify({ tool: "managedEnvironment", action: "install", isOutsideWorkspace: true })

describe("managed environment approval boundary", () => {
	it("never inherits all-actions, execute, write, or read approval", async () => {
		expect(await checkAutoApproval({ state, ask: "tool", text })).toEqual({ decision: "ask" })
	})

	it("accepts dedicated consent for the configured external root", async () => {
		expect(
			await checkAutoApproval({
				state: { ...state, alwaysAllowAll: false, alwaysAllowManagedEnvironments: true },
				ask: "tool",
				text,
			}),
		).toEqual({ decision: "approve" })
	})

	it.each(["autoApprovalEnabled", "managedEnvironmentsEnabled"] as const)("requires %s", async (key) => {
		expect(
			await checkAutoApproval({
				state: { ...state, alwaysAllowManagedEnvironments: true, [key]: false },
				ask: "tool",
				text,
			}),
		).toEqual({ decision: "ask" })
	})

	it.each(["requiresToolApproval", "isProtected"] as const)("respects %s", async (key) => {
		expect(
			await checkAutoApproval({
				state: { ...state, alwaysAllowManagedEnvironments: true },
				ask: "tool",
				text,
				[key]: true,
			}),
		).toEqual({ decision: "ask" })
	})

	it.each(["prepare", "status"])(
		"uses read-only consent for %s, not dedicated install consent or all-actions",
		async (action) => {
			for (const alwaysAllowReadOnly of [true, false]) {
				expect(
					await checkAutoApproval({
						state: { ...state, alwaysAllowManagedEnvironments: true, alwaysAllowReadOnly },
						ask: "tool",
						text: JSON.stringify({ tool: "managedEnvironment", action }),
					}),
				).toEqual({ decision: alwaysAllowReadOnly ? "approve" : "ask" })
			}
		},
	)

	it("does not infer consent for an unknown action", async () => {
		expect(
			await checkAutoApproval({
				state: { ...state, alwaysAllowManagedEnvironments: true },
				ask: "tool",
				text: JSON.stringify({ tool: "managedEnvironment", action: "delete" }),
			}),
		).toEqual({ decision: "ask" })
	})
})
