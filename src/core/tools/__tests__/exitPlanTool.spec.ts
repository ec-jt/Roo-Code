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
			userMessageContent: [] as any[],
		}
		// Mirror the real ordering: tool_result first, then any <user_message> block.
		task.pushUserFeedbackToUserContent = vi.fn((text?: string) => {
			if (text) task.userMessageContent.push({ type: "text", text: `<user_message>\n${text}\n</user_message>` })
		})
		pushToolResult = vi.fn((content: string) => task.userMessageContent.push({ type: "tool_result", content }))
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

	it("approve with text returns status-only tool result followed by a <user_message> block", async () => {
		task.ask.mockResolvedValue({ response: "yesButtonClicked", text: "Use Postgres, not SQLite" })
		await run(block("# Plan"))
		expect(task.planOverlay).toBe(false)
		expect(task.say).toHaveBeenCalledWith("user_feedback", "Use Postgres, not SQLite", undefined)
		const [toolResult, userMessage] = task.userMessageContent
		expect(toolResult.type).toBe("tool_result")
		expect(toolResult.content).not.toContain("Use Postgres")
		expect(toolResult.content).not.toContain("<user_message>")
		expect(JSON.parse(toolResult.content)).toMatchObject({ status: "approved" })
		expect(JSON.parse(toolResult.content).message).toContain(PLAN_APPROVED_RESULT)
		expect(userMessage).toEqual({ type: "text", text: "<user_message>\nUse Postgres, not SQLite\n</user_message>" })
		expect(task.userMessageContent).toHaveLength(2)
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

	describe("profiles", () => {
		const withMode = (plan: string, mode: string | null): ToolUse<"exit_plan"> =>
			({
				type: "tool_use",
				name: "exit_plan",
				params: { plan, ...(mode ? { mode } : {}) },
				nativeArgs: { plan, mode },
				partial: false,
			}) as ToolUse<"exit_plan">

		let apiConfiguration: { apiProvider: string; apiModelId: string }

		beforeEach(() => {
			apiConfiguration = { apiProvider: "anthropic", apiModelId: "claude-opus" }
			task.apiConfiguration = apiConfiguration
			task.taskMode = "architect"
			task.getTaskMode = vi.fn(async () => task.taskMode)
			provider.getState = vi.fn(async () => ({ customModes: [] }))
			// Mirrors the in-task path: only the task mode changes, never the provider configuration.
			provider.handleModeSwitch = vi.fn(async (mode: string) => {
				task.taskMode = mode
			})
		})

		it("hybrid approval switches to code once, keeps the model and shows the switch", async () => {
			task.profile = "hybrid"
			task.ask.mockResolvedValue({ response: "yesButtonClicked" })
			await run(withMode("# Plan", null))
			expect(provider.handleModeSwitch).toHaveBeenCalledTimes(1)
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("code")
			expect(task.taskMode).toBe("code")
			expect(task.apiConfiguration).toBe(apiConfiguration)
			expect(task.apiConfiguration).toEqual({ apiProvider: "anthropic", apiModelId: "claude-opus" })
			expect(task.say).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "switchMode", mode: "code", reason: "plan approved" }),
			)
			const result = pushToolResult.mock.calls[0][0]
			expect(result).toContain(PLAN_APPROVED_RESULT)
			expect(result).toContain("Code mode")
		})

		it("hybrid approval switches to the named mode", async () => {
			task.profile = "hybrid"
			task.ask.mockResolvedValue({ response: "yesButtonClicked" })
			await run(withMode("# Plan", "debug"))
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("debug")
			expect(task.taskMode).toBe("debug")
		})

		it("hybrid approval with an unknown mode falls back to code", async () => {
			task.profile = "hybrid"
			task.ask.mockResolvedValue({ response: "yesButtonClicked" })
			await run(withMode("# Plan", "no-such-mode"))
			expect(provider.handleModeSwitch).toHaveBeenCalledWith("code")
		})

		it("hybrid approval does not switch when already in the target mode", async () => {
			task.profile = "hybrid"
			task.taskMode = "code"
			task.ask.mockResolvedValue({ response: "yesButtonClicked" })
			await run(withMode("# Plan", null))
			expect(provider.handleModeSwitch).not.toHaveBeenCalled()
			expect(pushToolResult).toHaveBeenCalledWith(PLAN_APPROVED_RESULT)
		})

		it("hybrid keep planning does not switch", async () => {
			task.profile = "hybrid"
			task.ask.mockResolvedValue({ response: "noButtonClicked", text: "More detail" })
			await run(withMode("# Plan", "code"))
			expect(provider.handleModeSwitch).not.toHaveBeenCalled()
			expect(task.taskMode).toBe("architect")
		})

		it.each(["cordis", "modes"])("%s approval does not switch modes", async (profile) => {
			task.profile = profile
			task.ask.mockResolvedValue({ response: "yesButtonClicked" })
			await run(withMode("# Plan", "code"))
			expect(provider.handleModeSwitch).not.toHaveBeenCalled()
			expect(task.taskMode).toBe("architect")
			expect(pushToolResult).toHaveBeenCalledWith(PLAN_APPROVED_RESULT)
		})
	})
})
