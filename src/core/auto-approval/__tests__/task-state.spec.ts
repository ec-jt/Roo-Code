import { checkAutoApproval } from "../index"

const text = (action: string) => JSON.stringify({ tool: "taskState", action, content: "{}" })
const on = { autoApprovalEnabled: true, alwaysAllowReadOnly: true, alwaysAllowWrite: true }

describe("task_state approval (L1 defect 1)", () => {
	it("auto-approves a read with the read-only category and a patch with the write category", async () => {
		expect(await checkAutoApproval({ state: on as any, ask: "tool", text: text("read") })).toEqual({
			decision: "approve",
		})
		expect(await checkAutoApproval({ state: on as any, ask: "tool", text: text("patch") })).toEqual({
			decision: "approve",
		})
	})

	it("asks when the matching category is off, even when the other one is on", async () => {
		const readOff = { ...on, alwaysAllowReadOnly: false }
		const writeOff = { ...on, alwaysAllowWrite: false }
		expect(await checkAutoApproval({ state: readOff as any, ask: "tool", text: text("read") })).toEqual({
			decision: "ask",
		})
		expect(await checkAutoApproval({ state: writeOff as any, ask: "tool", text: text("patch") })).toEqual({
			decision: "ask",
		})
	})

	it("asks when auto-approval is off, for all-actions without the category, and for unknown actions", async () => {
		const master = { ...on, autoApprovalEnabled: false }
		const allOnly = { autoApprovalEnabled: true, alwaysAllowAll: true }
		for (const action of ["read", "patch"]) {
			expect(await checkAutoApproval({ state: master as any, ask: "tool", text: text(action) })).toEqual({
				decision: "ask",
			})
			expect(await checkAutoApproval({ state: allOnly as any, ask: "tool", text: text(action) })).toEqual({
				decision: "ask",
			})
		}
		expect(await checkAutoApproval({ state: on as any, ask: "tool", text: text("init") })).toEqual({
			decision: "ask",
		})
		expect(await checkAutoApproval({ state: undefined, ask: "tool", text: text("read") })).toEqual({
			decision: "ask",
		})
	})

	it("keeps task-local mandatory approval ahead of the categories", async () => {
		expect(
			await checkAutoApproval({ state: on as any, ask: "tool", text: text("patch"), requiresToolApproval: true }),
		).toEqual({ decision: "ask" })
	})
})
