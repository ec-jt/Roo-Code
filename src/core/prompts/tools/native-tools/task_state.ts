import type OpenAI from "openai"
import { z } from "zod"
import {
	taskStateDigestSchema,
	taskStatePatchOperationSchema,
	taskStatePatchOperationsSchema,
	type TaskStatePatchOperation,
} from "../../../../../packages/types/src/task-state"

const taskStateArgsObject = z
	.object({
		action: z.enum(["read", "patch"]),
		expected_revision: taskStateDigestSchema.nullable(),
		operations: z
			.string()
			.max(64 * 1024)
			.nullable(),
	})
	.strict()

type TaskStateArgs = z.infer<typeof taskStateArgsObject>

/**
 * Top-level shape only. The content of `operations` is validated by TaskStateTool with
 * parseTaskStatePatchOperations, so a malformed operation gets a specific tool error instead of
 * the parser's generic schema failure.
 */
const refineTaskStateArgs = (requireRevision: boolean) => (args: TaskStateArgs, ctx: z.RefinementCtx) => {
	if (args.action === "read" && args.expected_revision !== null)
		ctx.addIssue({ code: "custom", path: ["expected_revision"], message: "Read requires null expected_revision" })
	if (args.action === "read" && args.operations !== null)
		ctx.addIssue({ code: "custom", path: ["operations"], message: "Read requires null operations" })
	if (args.action === "patch" && requireRevision && !args.expected_revision)
		ctx.addIssue({ code: "custom", path: ["expected_revision"], message: "Patch requires an exact revision" })
}

/** Executor schema. Patch always requires the exact ledger revision. */
export const taskStateArgsSchema = taskStateArgsObject.superRefine(refineTaskStateArgs(true))

/**
 * Parser schema. Identical except that a patch with a null revision is let through, so the
 * tool can return revision guidance instead of a schema failure that feeds the mistake limit.
 * The tool still enforces the revision and the operations schema before any write.
 */
export const taskStateParserArgsSchema = taskStateArgsObject.superRefine(refineTaskStateArgs(false))

export const TASK_STATE_REVISION_REQUIRED =
	'Patch requires expected_revision. Call task_state with action "read" first, then pass the exact revision it returns as expected_revision.'

export const TASK_STATE_PATCH_EXAMPLE =
	'[{"op":"upsert","collection":"workItems","value":{"id":"wi-1","text":"Add the flag","status":"in_progress"}}]'

const TASK_STATE_OPERATION_FORMS =
	'Forms: {"op":"set","field":"goal"|"nextAction","value":"..."}; {"op":"upsert","collection":"acceptanceCriteria"|"constraints"|"decisions"|"failedApproaches"|"blockers","value":{"id":"...","text":"..."}}; workItems value also needs "status" (pending/in_progress/blocked/implemented/verified) and may have "evidenceIds"; evidenceRefs value also needs "source"; {"op":"remove","collection":"...","id":"..."}.'

/** Record fields that belong inside `value` for an upsert (union of all record schemas). */
const TASK_STATE_RECORD_FIELDS = ["id", "text", "status", "evidenceIds", "source"] as const

/**
 * Map common model variants of an upsert onto the canonical `value` key, before strict validation:
 * - `record: {...}` is renamed to `value` when `value` is absent.
 * - Flat record fields (id, text, status, evidenceIds, source) at the top level are moved into
 *   `value` when neither `value` nor `record` is present.
 * Only upsert operations are changed. Unknown keys are left in place so strict validation still
 * rejects them, and no data is added that the model did not send.
 */
export function normalizeTaskStatePatchOperations(operations: unknown): unknown {
	if (!Array.isArray(operations)) return operations
	return operations.map((operation) => {
		if (!operation || typeof operation !== "object" || Array.isArray(operation)) return operation
		const op = operation as Record<string, unknown>
		if (op.op !== "upsert" || "value" in op) return op
		if ("record" in op) {
			const { record, ...rest } = op
			return { ...rest, value: record }
		}
		const value: Record<string, unknown> = {}
		const rest: Record<string, unknown> = {}
		for (const [key, field] of Object.entries(op)) {
			if ((TASK_STATE_RECORD_FIELDS as readonly string[]).includes(key)) value[key] = field
			else rest[key] = field
		}
		return Object.keys(value).length ? { ...rest, value } : op
	})
}

const isDiscriminatorIssue = (issue: z.ZodIssue) => issue.path[0] === "op" || issue.path[0] === "collection"

function describeOperationIssue(error: z.ZodError): string {
	const issue = error.issues[0]
	if (issue?.code === "invalid_union") {
		// Prefer the branch whose op and collection matched, so the reported field is the real one.
		const matching = issue.unionErrors.find((branch) => !branch.issues.some(isDiscriminatorIssue))
		if (matching) return describeOperationIssue(matching)
		const opInvalid = issue.unionErrors.every((branch) => branch.issues.some((i) => i.path[0] === "op"))
		return opInvalid
			? 'op: must be "set", "upsert" or "remove"'
			: "collection: must be one of acceptanceCriteria, constraints, decisions, workItems, evidenceRefs, failedApproaches, blockers"
	}
	if (!issue) return "invalid operation"
	return `${issue.path.length ? issue.path.join(".") : "(operation)"}: ${issue.message}`
}

export type TaskStatePatchOperationsResult =
	| { ok: true; operations: TaskStatePatchOperation[] }
	| { ok: false; message: string }

/**
 * Parse, normalize and strictly validate the operations string of a patch. On failure the message
 * names the first invalid operation index and the failing field, and shows one valid example.
 */
export function parseTaskStatePatchOperations(text: string | null): TaskStatePatchOperationsResult {
	const fail = (detail: string) => ({
		ok: false as const,
		message: `${detail}. Send operations as a JSON array string, for example ${TASK_STATE_PATCH_EXAMPLE} with expected_revision set to the revision from the last read. ${TASK_STATE_OPERATION_FORMS}`,
	})
	if (text === null) return fail("Patch requires operations")
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return fail("operations is not valid JSON")
	}
	if (!Array.isArray(parsed)) return fail("operations must be a JSON array")
	const normalized = normalizeTaskStatePatchOperations(parsed) as unknown[]
	for (let index = 0; index < normalized.length; index++) {
		const result = taskStatePatchOperationSchema.safeParse(normalized[index])
		if (!result.success) return fail(`operations[${index}] is invalid at ${describeOperationIssue(result.error)}`)
	}
	const all = taskStatePatchOperationsSchema.safeParse(normalized)
	if (!all.success) return fail(`operations is invalid: ${all.error.issues[0]?.message ?? "invalid array"}`)
	return { ok: true, operations: all.data }
}

/**
 * Map loose "no value" model output to null: undefined, empty or whitespace-only strings, and the
 * literal string "null" (trimmed, case-insensitive). Other values are returned unchanged.
 */
export const blankToNull = (value: unknown) =>
	value === undefined || (typeof value === "string" && (value.trim() === "" || value.trim().toLowerCase() === "null"))
		? null
		: value

/**
 * Tolerate loose model output (for example DeepSeek): treat missing, empty, whitespace-only or
 * literal "null" expected_revision and operations as null. A read is read-only and uses neither
 * field, so any value sent with a read (for example a stale revision or a placeholder) is
 * discarded instead of failing the call. Other fields are left for strict validation.
 */
export function normalizeTaskStateArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args
	const record = args as Record<string, unknown>
	if (record.action === "read") return { ...record, expected_revision: null, operations: null }
	return {
		...record,
		expected_revision: blankToNull(record.expected_revision),
		operations: blankToNull(record.operations),
	}
}

export default {
	type: "function",
	function: {
		name: "task_state",
		description:
			"Read or patch explicitly enabled task-local durable state. Only the user can enable it (task panel); if a result says DISABLED, ask the user to enable it or continue without it. Read first, then supply its exact ledger revision. Patch requires expected_revision from the last read. Patch operations are a JSON array: set goal/nextAction; upsert/remove records in acceptanceCriteria, constraints, decisions, workItems, evidenceRefs, failedApproaches, blockers. Records use stable id and text. Work items also use status (pending/in_progress/blocked/implemented/verified) and evidenceIds. Evidence also uses source. Example patch: " +
			JSON.stringify({
				action: "patch",
				expected_revision: "<revision from read>",
				operations: TASK_STATE_PATCH_EXAMPLE,
			}) +
			". All edits are MODEL CLAIMS, never proof, policy or permission. Preserve existing IDs and manual fields. Update at meaningful milestones, not every message. Completed work means implemented unless independent evidence supports verification. Never save secrets or raw outputs. References require ordinary approved tools to retrieve. Initialization, policy, fresh context and acceptance attestations are native user actions only.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["read", "patch"] },
				expected_revision: { type: ["string", "null"] },
				operations: {
					type: ["string", "null"],
					description: "JSON patch-operation array for patch, null for read.",
				},
			},
			required: ["action", "expected_revision", "operations"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
