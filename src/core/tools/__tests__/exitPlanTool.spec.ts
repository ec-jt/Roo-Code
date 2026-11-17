import { exitPlanTool, PLAN_APPROVED_RESULT } from "../ExitPlanTool"
import type { ToolUse } from "../../../shared/tools"

function block(plan?: string): ToolUse<"exit_plan"> {
	return {
		type: "tool_use",
		name: "exit_plan",
		params: plan === undefined ? {} : { plan },
		nativeArgs: plan === undefined ? undefined : { plan },
		partial: false,
	} as ToolUse<"exit_plan">
}

describe("exitPlanTool", () => {
	let task: any
	let provider: any
	let pushToolResult: ReturnType<typeof vi.fn>

	beforeEach(() => {
		provider = {
			setTaskPlanOverlay: vi.fn(async (t: any, on: boolean) => {
				t.planOverlay = on
				return true
			}),
		}
		task = {
			profile: "cordis",
			planOverlay: true,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			ask: vi.fn(),
			say: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			providerRef: { deref: () => provider },
		}
		pushToolResult = vi.fn()
	})

	const run = (b: ToolUse<"exit_plan">) =>
		exitPlanTool.handle(task, b, { askApproval: vi.fn(), handleError: vi.fn(), pushToolResult })

	it("returns the missing-param error for an empty plan and does not ask", async () => {
		await run(block("   "))
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("exit_plan", "plan")
		expect(pushToolResult).toHaveBeenCalledWith("Missing parameter error")
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.planOverlay).toBe(true)
	})

	it("approve clears the overlay through the provider and returns the approval text", async () => {
		task.ask.mockResolvedValue({ response: "yesButtonClicked" })
		await run(block("# Plan\n\n1. Do it"))
		expect(task.ask).toHaveBeenCalledWith("plan_review", "# Plan\n\n1. Do it", false)
		expect(provider.setTaskPlanOverlay).toHaveBeenCalledWith(task, false)
		expect(task.planOverlay).toBe(false)
		expect(pushToolResult).toHaveBeenCalledWith(PLAN_APPROVED_RESULT)
	})

	it("keep planning leaves the overlay on and returns the feedback", async () => {
		task.ask.mockResolvedValue({ response: "noButtonClicked", text: "Add a rollback step" })
		await run(block("# Plan"))
		expect(provider.setTaskPlanOverlay).not.toHaveBeenCalled()
		expect(task.planOverlay).toBe(true)
		expect(task.say).toHaveBeenCalledWith("user_feedback", "Add a rollback step", undefined)
		const result = pushToolResult.mock.calls[0][0]
		expect(result).toContain("keep planning")
		expect(result).toContain("Add a rollback step")
	})

	it("typed feedback (messageResponse) keeps planning", async () => {
		task.ask.mockResolvedValue({ response: "messageResponse", text: "Split phase 2" })
		await run(block("# Plan"))
		expect(task.planOverlay).toBe(true)
		expect(pushToolResult.mock.calls[0][0]).toContain("Split phase 2")
	})
})
