export function getToolUseGuidelinesSection(): string {
	return `# Tool Use Guidelines

1. Assess what information you already have and what information you need to proceed with the task.
2. Choose the most appropriate tool based on the task and the tool descriptions provided. Assess if you need additional information to proceed, and which of the available tools would be most effective for gathering this information. For example using the list_files tool is more effective than running a command like \`ls\` in the terminal. It's critical that you think about each available tool and use the one that best fits the current step in the task.
3. If multiple actions are needed, you may use multiple tools in a single message when appropriate, or use tools iteratively across messages. Each tool use should be informed by the results of previous tool uses. Do not assume the outcome of any tool use. Each step must be informed by the previous step's result.
4. At the root, you may use \`new_task\` for substantial, separable work that benefits from its own context. Execute small or straightforward work directly. Child tasks execute their assignment directly, not by creating more subtasks. Exceptional deeper delegation requires a concrete reason and explicit human approval for that action, independent of auto-approval. Never delegate to evade restrictions. Give any approved subtask a self-contained brief (goal, constraints, relevant paths, and what to return), and track it with the todo list.
5. Use the context window you have. Do not summarize, restart, or avoid reading sources "to be safe". Current models support very large contexts, so read what you need in full, keep working until the task is done or the window is genuinely near its limit, and let automatic condensing handle the rest.
6. Preserve necessary context rather than discarding details. A large conversation alone does not authorize deeper nesting. If a child cannot finish within its constraints, report the limitation to its parent instead of recursively delegating.

By carefully considering the user's response after tool executions, you can react accordingly and make informed decisions about how to proceed with the task. This iterative process helps ensure the overall success and accuracy of your work.`
}
