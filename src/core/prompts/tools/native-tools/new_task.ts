import type OpenAI from "openai"

const NEW_TASK_DESCRIPTION = `Create a new task instance in the chosen mode using your provided message and initial todo list (if required).

At the root (depth 0), you may delegate substantial, separable work to a child (depth 1). Execute small tasks directly. Children execute their assignment directly, without further delegation by default. An exceptional deeper request requires a concrete reason and explicit per-action human approval unless nested-subtask auto approval is explicitly enabled. Ordinary subtask or all-actions auto approval alone does not permit deeper auto approval. Each additional level is checked separately, including mandatory approval fences. Never delegate to evade restrictions or gain wider tool/file capabilities. If blocked or denied, finish in the current task or report the limitation to the parent.

Root delegation can be useful for:
- Investigation that will touch many files or produce large intermediate output, such as log analysis, stack traces, or dependency tracing.
- Trial-and-error debugging where most attempts are noise you would not want to keep.
- An independent chunk of a larger plan that can be completed and reported back.
- Bounded implementation or testing work in code mode. Children are not inherently read-only; select a mode that permits the assigned work and respect caller constraints.
- Work that would otherwise consume most of this conversation's remaining context.

Write the subtask a self-contained brief: the goal, the constraints, relevant paths, clear file ownership to avoid conflicting edits, and exactly what it should return, including changes and test results for implementation work. The subtask starts with no memory of this conversation, so include everything it needs. Record the delegation in the todo list, and keep only the subtask's result here rather than its intermediate output.

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
				reason: {
					type: ["string", "null"],
					description:
						"Concrete justification for exceptional deeper delegation from a child. Required for depth 2 or deeper even with nested-subtask auto approval; omit or use null for ordinary root delegation. Human approval is required unless nested-subtask auto approval is explicitly enabled and all policy checks pass.",
				},
			},
			required: ["mode", "message", "todos", "reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
