/**
 * Delegation tools hand work to subtasks. A delegation tool must be the last tool call in its
 * assistant turn: tool calls after it are not executed and receive an error tool_result instead.
 * `new_task` and `new_tasks` follow the same rule.
 */

export const DELEGATION_TOOL_NAMES = ["new_task", "new_tasks"] as const

export type DelegationToolName = (typeof DELEGATION_TOOL_NAMES)[number]

export function isDelegationTool(name: unknown): name is DelegationToolName {
	return typeof name === "string" && (DELEGATION_TOOL_NAMES as readonly string[]).includes(name)
}

/** Index of the first delegation tool_use block, or -1. */
export function findDelegationToolIndex(blocks: ReadonlyArray<{ type: string; name?: unknown }>): number {
	return blocks.findIndex((block) => block.type === "tool_use" && isDelegationTool(block.name))
}

/** Error text for a tool call that was dropped because a delegation tool came before it. */
export function delegationTruncationMessage(toolName: string): string {
	return `This tool was not executed because ${toolName} was called in the same message turn. The ${toolName} tool must be the last tool in a message.`
}
