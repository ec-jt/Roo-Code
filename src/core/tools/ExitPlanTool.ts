import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { ToolUse } from "../../shared/tools"
import { getModeBySlug } from "../../shared/modes"
import { HYBRID_DEFAULT_TARGET_MODE } from "../task/cordis-profile"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface ExitPlanParams {
	plan: string
	mode?: string | null
}

export const PLAN_APPROVED_RESULT = "Plan approved. Continue with implementation."

/**
 * In a hybrid task, switches to the target mode after an approved plan, through the in-task
 * mode-switch path (`handleModeSwitch`), so the model and provider profile stay the same (Q-USE-1).
 * Returns a sentence for the tool result, or undefined when no switch happened.
 */
async function switchToTargetMode(task: Task, requested: string | null | undefined): Promise<string | undefined> {
	const provider = task.providerRef.deref()
	if (!provider) return undefined
	const state = await provider.getState()
	const customModes = state?.customModes
	const slug = requested?.trim() || HYBRID_DEFAULT_TARGET_MODE
	const target = getModeBySlug(slug, customModes) ?? getModeBySlug(HYBRID_DEFAULT_TARGET_MODE, customModes)
	if (!target) return undefined
	const current = await task.getTaskMode()
	if (current === target.slug) return undefined
	await provider.handleModeSwitch(target.slug)
	const reason = "plan approved"
	await task.say("tool", JSON.stringify({ tool: "switchMode", mode: target.slug, reason }))
	const fallback = requested?.trim() && requested.trim() !== target.slug ? ` (unknown mode "${requested}")` : ""
	return `Switched from ${getModeBySlug(current, customModes)?.name ?? current} mode to ${target.name} mode${fallback}.`
}

/**
 * Submits a plan for user review (Cordis and hybrid tasks; the modes profile disables this tool).
 * Approve turns the plan overlay off and, in a hybrid task, switches once to the target mode
 * (`mode` parameter, default code). Keep planning leaves both unchanged and returns the feedback.
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
				const switched = task.profile === "hybrid" ? await switchToTargetMode(task, params.mode) : undefined
				const approved = switched ? `${PLAN_APPROVED_RESULT} ${switched}` : PLAN_APPROVED_RESULT
				if (text || images?.length) {
					// Same contract as approval-with-feedback for other tools: the tool result carries
					// status JSON only; the user's text follows as a separate <user_message> block.
					await task.say("user_feedback", text ?? "", images)
					pushToolResult(
						JSON.stringify({
							status: "approved",
							message: `${approved} The user sent a message with the approval. It follows this tool result.`,
						}),
					)
					task.pushUserFeedbackToUserContent(text, images)
				} else {
					pushToolResult(approved)
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
