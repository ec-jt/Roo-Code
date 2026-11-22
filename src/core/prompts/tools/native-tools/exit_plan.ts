import type OpenAI from "openai"

const EXIT_PLAN_DESCRIPTION = `Submit a plan for user review. Use it to finish plan mode, or to propose an amendment when architecture drift blocks the current plan. The user either approves the plan (plan mode ends and you continue with implementation) or keeps planning and sends feedback (revise the plan and call this tool again). Do not implement the plan before approval.`

const PLAN_PARAMETER_DESCRIPTION = `The full plan in Markdown, starting with a heading. For a drift amendment, include the drift, the proposed record change, and the updated plan.`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode that implements the plan after approval (e.g., code, debug). Used only when the task can switch modes; it then switches to this mode on approval. Use null for the default (code).`

export default {
	type: "function",
	function: {
		name: "exit_plan",
		description: EXIT_PLAN_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				plan: {
					type: "string",
					description: PLAN_PARAMETER_DESCRIPTION,
				},
				mode: {
					type: ["string", "null"],
					description: MODE_PARAMETER_DESCRIPTION,
				},
			},
			required: ["plan", "mode"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
