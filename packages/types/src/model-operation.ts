import { z } from "zod"

// Reject blank identities without normalizing distinct caller-supplied values.
const identitySchema = z.string().refine((id) => id.trim().length > 0, "Identity must not be blank")
const revisionSchema = z.number().int().nonnegative().safe()

/** A model operation scoped to a specific task instance and revision. */
export const modelOperationSchema = z
	.object({
		operationId: identitySchema,
		kind: z.enum(["regenerate", "switch"]),
		taskId: identitySchema,
		instanceId: identitySchema,
		revision: revisionSchema,
		profileId: identitySchema,
		requestId: identitySchema.optional(),
		confirmCurrentWorkspace: z.boolean(),
	})
	.strict()

export type ModelOperation = z.infer<typeof modelOperationSchema>

/** A response to a tool approval for a specific task instance and revision. */
export const modelOperationApprovalSchema = z
	.object({
		taskId: identitySchema,
		instanceId: identitySchema,
		revision: revisionSchema,
		approvalId: identitySchema,
		approved: z.boolean(),
	})
	.strict()

export type ModelOperationApproval = z.infer<typeof modelOperationApprovalSchema>

/** Progress or outcome of a model operation. */
export const modelOperationStatusSchema = z
	.object({
		operationId: identitySchema,
		status: z.enum(["running", "completed", "blocked", "failed"]),
		message: z.string(),
		taskId: identitySchema.optional(),
		instanceId: identitySchema.optional(),
		revision: revisionSchema.optional(),
	})
	.strict()

export type ModelOperationStatus = z.infer<typeof modelOperationStatusSchema>

/** Current model-operation readiness and any pending tool approval. */
export const modelOperationStateSchema = z
	.object({
		taskId: identitySchema,
		instanceId: identitySchema,
		revision: revisionSchema,
		requestId: identitySchema.optional(),
		profileId: identitySchema.optional(),
		readiness: z.enum(["ready", "blocked"]),
		reason: z.string().optional(),
		requiresToolApproval: z.boolean(),
		approval: z
			.object({
				approvalId: identitySchema,
				toolName: identitySchema,
			})
			.strict()
			.optional(),
	})
	.strict()

export type ModelOperationState = z.infer<typeof modelOperationStateSchema>
