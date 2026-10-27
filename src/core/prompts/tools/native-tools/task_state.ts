import type OpenAI from "openai"
import { z } from "zod"
import { taskStateDigestSchema, taskStatePatchOperationsSchema } from "../../../../../packages/types/src/task-state"

export const taskStateArgsSchema = z
	.object({
		action: z.enum(["read", "patch"]),
		expected_revision: taskStateDigestSchema.nullable(),
		operations: z
			.string()
			.max(64 * 1024)
			.nullable(),
	})
	.strict()
	.superRefine((args, ctx) => {
		if (args.action === "read" && (args.expected_revision !== null || args.operations !== null))
			ctx.addIssue({ code: "custom", message: "Read requires null revision and operations" })
		if (args.action === "patch") {
			if (!args.expected_revision || !args.operations)
				ctx.addIssue({ code: "custom", message: "Patch requires an exact revision and JSON operations" })
			try {
				taskStatePatchOperationsSchema.parse(JSON.parse(args.operations!))
			} catch {
				ctx.addIssue({ code: "custom", message: "Invalid task state operations" })
			}
		}
	})

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
