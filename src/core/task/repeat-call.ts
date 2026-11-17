/**
 * Repeat-call reminder. Counts consecutive tool calls with identical arguments and returns a short
 * note at fixed thresholds. It never blocks a call.
 */

/** Tools that neither count nor reset the chain. */
export const REPEAT_CALL_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
	"update_todo_list",
	"task_state",
	"ask_followup_question",
	"attempt_completion",
])

/** Counts at which the note is appended. */
export const REPEAT_CALL_THRESHOLDS: ReadonlySet<number> = new Set([3, 5, 8])

export interface RepeatChain {
	key: string
	count: number
}

export interface RepeatChainHolder {
	repeatChain?: RepeatChain
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
		)
	}
	return value
}

/** Tool name plus JSON of the arguments with sorted keys. */
export function repeatCallKey(toolName: string, args: unknown): string {
	let json: string
	try {
		json = JSON.stringify(sortKeys(args ?? {})) ?? ""
	} catch {
		json = String(args)
	}
	return `${toolName}:${json}`
}

export function repeatCallNote(toolName: string, count: number): string {
	return `Note: this is call ${count} of ${toolName} with identical arguments. Check the previous result and change approach, or finish.`
}

/**
 * Records one tool call on the holder (a Task). Returns the note to append to the tool result when
 * the chain reaches a threshold, otherwise undefined.
 */
export function recordRepeatCall(holder: RepeatChainHolder, toolName: string, args: unknown): string | undefined {
	if (REPEAT_CALL_EXCLUDED_TOOLS.has(toolName)) return undefined
	const key = repeatCallKey(toolName, args)
	const chain = holder.repeatChain
	const count = chain && chain.key === key ? chain.count + 1 : 1
	holder.repeatChain = { key, count }
	return REPEAT_CALL_THRESHOLDS.has(count) ? repeatCallNote(toolName, count) : undefined
}

/** Resets the chain. Called when the user sends a new message. */
export function resetRepeatCalls(holder: RepeatChainHolder): void {
	holder.repeatChain = undefined
}
