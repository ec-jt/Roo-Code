import { clineAskSchema } from "@roo-code/types"

import { checkAutoApproval } from "../index"

const permissiveState = {
	autoApprovalEnabled: true,
	alwaysAllowAll: true,
	alwaysAllowReadOnly: true,
	alwaysAllowReadOnlyOutsideWorkspace: true,
	alwaysAllowWrite: true,
	alwaysAllowWriteOutsideWorkspace: true,
	alwaysAllowWriteProtected: true,
	alwaysAllowBrowser: true,
	alwaysAllowMcp: true,
	alwaysAllowModeSwitch: true,
	alwaysAllowSubtasks: true,
	alwaysAllowNestedSubtasks: true,
	alwaysAllowExecute: true,
	allowedCommands: ["*"],
	deniedCommands: [],
	alwaysAllowFollowupQuestions: true,
	followupAutoApproveTimeoutMs: 1000,
}

describe("model-operation mandatory approval", () => {
	it.each(clineAskSchema.options)("forces manual approval for %s even with all-actions enabled", async (ask) => {
		expect(
			await checkAutoApproval({
				state: permissiveState,
				ask,
				text: JSON.stringify({ suggest: [{ answer: "yes" }] }),
				requiresToolApproval: true,
			}),
		).toEqual({ decision: "ask" })
	})

	it.each(["readFile", "editedExistingFile", "switchMode", "newTask", "finishTask", "updateTodoList", "skill"])(
		"prevents category and special-case approval of %s",
		async (tool) => {
			expect(
				await checkAutoApproval({
					state: { ...permissiveState, alwaysAllowAll: false },
					ask: "tool",
					text: JSON.stringify({ tool }),
					requiresToolApproval: true,
				}),
			).toEqual({ decision: "ask" })
		},
	)

	it("does not read global settings in mandatory context", async () => {
		const state = new Proxy(permissiveState, {
			get() {
				throw new Error("Global settings must not be read")
			},
		})
		expect(await checkAutoApproval({ state, ask: "command", requiresToolApproval: true })).toEqual({
			decision: "ask",
		})
	})

	it.each([undefined, { ...permissiveState, autoApprovalEnabled: false }])(
		"overrides nonblocking approval regardless of global state",
		async (state) => {
			expect(await checkAutoApproval({ state, ask: "command_output", requiresToolApproval: true })).toEqual({
				decision: "ask",
			})
		},
	)

	it("overrides automatic command denial as well as approval", async () => {
		expect(
			await checkAutoApproval({
				state: { ...permissiveState, alwaysAllowAll: false, deniedCommands: ["rm"] },
				ask: "command",
				text: "rm file",
				requiresToolApproval: true,
			}),
		).toEqual({ decision: "ask" })
	})

	it.each([undefined, false])("preserves existing auto-approval when the context flag is %s", async (flag) => {
		expect(await checkAutoApproval({ state: permissiveState, ask: "command", requiresToolApproval: flag })).toEqual(
			{ decision: "approve" },
		)
		expect(await checkAutoApproval({ ask: "command_output", requiresToolApproval: flag })).toEqual({
			decision: "approve",
		})
		expect(await checkAutoApproval({ ask: "command", requiresToolApproval: flag })).toEqual({ decision: "ask" })
	})
})
