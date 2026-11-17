import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ExitPlanParams {
	plan: string
}

export const PLAN_APPROVED_RESULT = "Plan approved. Continue with implementation."

/**
 * Submits a plan for user review (Cordis tasks only; the modes profile disables this tool).
 * Approve turns the plan overlay off. Keep planning leaves it unchanged and returns the feedback.
 * The `plan_review` ask is never auto-approved.
 */
export class ExitPlanTool extends BaseTool<"exit_plan"> {
	readonly name = "exit_plan" as const

	async execute(params: ExitPlanParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { plan } = params
		const { handleError, pushToolResult } = callbacks

		try {
			if (!plan || !plan.trim()) {
				task.consecutiveMistakeCount++
				task.recordToolError("exit_plan")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("exit_plan", "plan"))
				return
			}

			task.consecutiveMistakeCount = 0
			const { response, text, images } = await task.ask("plan_review", plan, false)

			if (response === "yesButtonClicked") {
				const provider = task.providerRef.deref()
				if (provider) {
					await provider.setTaskPlanOverlay(task, false)
				} else {
					task.planOverlay = false
				}
				if (text || images?.length) {
					await task.say("user_feedback", text ?? "", images)
					pushToolResult(
						formatResponse.toolResult(
							`${PLAN_APPROVED_RESULT}\n<user_message>\n${text ?? ""}\n</user_message>`,
							images,
						),
					)
				} else {
					pushToolResult(PLAN_APPROVED_RESULT)
				}
				return
			}

			// Keep planning: the overlay stays as it is.
			if (text || images?.length) await task.say("user_feedback", text ?? "", images)
			pushToolResult(
				formatResponse.toolResult(
					`The user did not approve the plan and wants to keep planning. Revise the plan and call exit_plan again.\n<user_message>\n${text ?? ""}\n</user_message>`,
					images,
				),
			)
		} catch (error) {
			await handleError("submitting plan", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"exit_plan">): Promise<void> {
		const plan: string | undefined = block.nativeArgs?.plan ?? block.params.plan
		await task.ask("plan_review", plan ?? "", block.partial).catch(() => {})
	}
}

export const exitPlanTool = new ExitPlanTool()
