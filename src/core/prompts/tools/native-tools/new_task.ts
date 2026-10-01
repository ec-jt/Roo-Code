import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `Create a new task instance in the chosen mode using your provided message and initial todo list (if required).

Use this tool to delegate work to a fresh context, which is the primary way to keep a long-horizon task manageable. Delegate when a piece of work is context heavy or self-contained:
- Investigation that will touch many files or produce large intermediate output, such as log analysis, stack traces, or dependency tracing.
- Trial-and-error debugging where most attempts are noise you would not want to keep.
- An independent chunk of a larger plan that can be completed and reported back.
- Work that would otherwise consume most of this conversation's remaining context.

Write the subtask a self-contained brief: the goal, the constraints, relevant paths, and exactly what it should return. The subtask starts with no memory of this conversation, so include everything it needs. Record the delegation in the todo list, and keep only the subtask's result here rather than its intermediate output.

CRITICAL: This tool MUST be called alone. Do NOT call this tool alongside other tools in the same message turn. If you need to gather information before delegating, use other tools in a separate turn first, then call new_task by itself in the next turn.`

const MODE_PARAMETER_DESCRIPTION = `Slug of the mode to begin the new task in (e.g., code, debug, architect)`

const MESSAGE_PARAMETER_DESCRIPTION = `Initial user instructions or context for the new task`

const TODOS_PARAMETER_DESCRIPTION = `Optional initial todo list written as a markdown checklist; required when the workspace mandates todos`

export default {
	type: "function",
	function: {
		name: "new_task",
		description: NEW_TASK_DESCRIPTION,
		strict: true,
		parameters: {
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
				todos: {
					type: ["string", "null"],
					description: TODOS_PARAMETER_DESCRIPTION,
				},
			},
			required: ["mode", "message", "todos"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
