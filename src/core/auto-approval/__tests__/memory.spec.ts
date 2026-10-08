import { checkAutoApproval } from "../index"

const state = { autoApprovalEnabled: true, alwaysAllowAll: true, memoryEnabledForCurrentProject: true }
const text = (path = "project", action = "upsert") => JSON.stringify({ tool: "memory", path, action })

describe("memory approval boundary", () => {
	it("uses project opt-in independently of global auto approval", async () => {
		expect(
			await checkAutoApproval({ state: { ...state, autoApprovalEnabled: false }, ask: "tool", text: text() }),
		).toEqual({ decision: "approve" })
	})
	it("does not inherit all-actions without project consent", async () => {
		expect(
			await checkAutoApproval({
				state: { ...state, memoryEnabledForCurrentProject: false },
				ask: "tool",
				text: text(),
			}),
		).toEqual({ decision: "ask" })
	})
	it.each(["read", "list", "upsert", "delete"])("never auto approves personal %s", async (action) => {
		expect(await checkAutoApproval({ state, ask: "tool", text: text("personal", action) })).toEqual({
			decision: "ask",
		})
	})
	it.each(["requiresToolApproval", "isProtected"] as const)("preserves %s", async (key) => {
		expect(await checkAutoApproval({ state, ask: "tool", text: text(), [key]: true })).toEqual({ decision: "ask" })
	})
	it("rejects unknown operations", async () => {
		expect(await checkAutoApproval({ state, ask: "tool", text: text("project", "import") })).toEqual({
			decision: "ask",
		})
	})
})
