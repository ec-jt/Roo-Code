/** Compatible servers use either spelling for plain-text reasoning deltas.
 * Prefer the established field when both are present; never duplicate aliases
 * or coerce structured/opaque reasoning into displayed text.
 */
export function getReasoningDelta(delta: unknown): string | undefined {
	if (!delta || typeof delta !== "object") return undefined
	const fields = delta as Record<string, unknown>
	for (const value of [fields.reasoning_content, fields.reasoning]) {
		if (typeof value === "string" && value.length > 0) return value
	}
	return undefined
}
