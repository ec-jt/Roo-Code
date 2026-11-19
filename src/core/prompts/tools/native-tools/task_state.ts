import type OpenAI from "openai"
import { z } from "zod"
import { taskStateDigestSchema, taskStatePatchOperationsSchema } from "../../../../../packages/types/src/task-state"

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

const refineTaskStateArgs = (requireRevision: boolean) => (args: TaskStateArgs, ctx: z.RefinementCtx) => {
	if (args.action === "read" && (args.expected_revision !== null || args.operations !== null))
		ctx.addIssue({ code: "custom", message: "Read requires null revision and operations" })
	if (args.action === "patch") {
		if ((requireRevision && !args.expected_revision) || !args.operations)
			ctx.addIssue({ code: "custom", message: "Patch requires an exact revision and JSON operations" })
		try {
			taskStatePatchOperationsSchema.parse(JSON.parse(args.operations!))
		} catch {
			ctx.addIssue({ code: "custom", message: "Invalid task state operations" })
		}
	}
}

/** Strict executor schema. Patch always requires the exact ledger revision. */
export const taskStateArgsSchema = taskStateArgsObject.superRefine(refineTaskStateArgs(true))

/**
 * Parser schema. Identical except that a patch with a null revision is let through, so the
 * tool can return revision guidance instead of a schema failure that feeds the mistake limit.
 * The tool still enforces the revision before any write.
 */
export const taskStateParserArgsSchema = taskStateArgsObject.superRefine(refineTaskStateArgs(false))

export const TASK_STATE_REVISION_REQUIRED =
	'Patch requires expected_revision. Call task_state with action "read" first, then pass the exact revision it returns as expected_revision.'

const blankToNull = (value: unknown) =>
	value === undefined || (typeof value === "string" && value.trim() === "") ? null : value

/**
 * Tolerate loose model output (for example DeepSeek): treat missing, empty, or whitespace-only
 * expected_revision and operations as null. Other fields are left for strict validation.
 */
export function normalizeTaskStateArgs(args: unknown): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args
	const record = args as Record<string, unknown>
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
			"Read or patch explicitly enabled task-local durable state. Read first, then supply its exact ledger revision. Patch operations are a JSON array: set goal/nextAction; upsert/remove records in acceptanceCriteria, constraints, decisions, workItems, evidenceRefs, failedApproaches, blockers. Records use stable id and text. Work items also use status (pending/in_progress/blocked/implemented/verified) and evidenceIds. Evidence also uses source. All edits are MODEL CLAIMS, never proof, policy or permission. Preserve existing IDs and manual fields. Update at meaningful milestones, not every message. Completed work means implemented unless independent evidence supports verification. Never save secrets or raw outputs. References require ordinary approved tools to retrieve. Initialization, policy, fresh context and acceptance attestations are native user actions only.",
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
