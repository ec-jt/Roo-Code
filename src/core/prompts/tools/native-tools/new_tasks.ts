import type OpenAI from "openai"

/**
 * Parallel subtasks (ADR-2026-11-22-parallel-subtasks). Offered only when the `parallelSubtasks`
 * experiment is on, in Orchestrator mode or in `cordis`/`hybrid` tasks, and never to a parallel
 * child (see filterParallelSubtasksTool in build-tools.ts).
 */
const NEW_TASKS_DESCRIPTION = `Start 2 to 4 independent subtasks in parallel. Each subtask works in its own git worktree on its own branch. Subtasks cannot ask the user: a tool that needs approval is refused, and the subtask reports it in its result. Each subtask stops when it is done or when the shared token budget of the batch runs out.

Use this only for independent work that does not touch the same files. You approve nothing per subtask: the user approves the whole batch once. You receive all the results together in one tool result (stop reason, summary, branch, diff stat, uncommitted files, refused approvals). Nothing is merged automatically: you then review and merge the branches.

Write each subtask a self-contained brief: the goal, the constraints, the files it owns, and exactly what it should return. A subtask starts with no memory of this conversation.

CRITICAL: This tool MUST be called alone. Do NOT call it alongside other tools in the same message turn.`

const TASKS_PARAMETER_DESCRIPTION = `The subtasks to start in parallel: 2 to 4 entries, each with a mode and a message`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode the subtask runs in (e.g., code, debug)`

const MESSAGE_PARAMETER_DESCRIPTION = `Self-contained instructions for the subtask`

export default {
	type: "function",
	function: {
		name: "new_tasks",
		description: NEW_TASKS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					description: TASKS_PARAMETER_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							mode: {
								type: "string",
								description: MODE_PARAMETER_DESCRIPTION,
							},
							message: {
								type: "string",
								description: MESSAGE_PARAMETER_DESCRIPTION,
							},
						},
						required: ["mode", "message"],
						additionalProperties: false,
					},
					minItems: 2,
					maxItems: 4,
				},
			},
			required: ["tasks"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
