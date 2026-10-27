import { z } from "zod"

export const taskStateIdSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
export const taskStateDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const text = z
	.string()
	.max(8_000)
	.refine((value) => !value.includes("\0"))
export const taskStateRecordSchema = z.object({ id: taskStateIdSchema, text }).strict()
export const taskStateWorkItemSchema = taskStateRecordSchema
	.extend({
		status: z.enum(["pending", "in_progress", "blocked", "implemented", "verified"]),
		evidenceIds: z.array(taskStateIdSchema).max(100).default([]),
	})
	.strict()
export const taskStateEvidenceSchema = taskStateRecordSchema
	.extend({
		source: text,
		provenance: z.enum(["model_claim", "user_claim", "runtime_observed"]),
		observedAt: z.string().datetime().optional(),
	})
	.strict()
export const taskStateDataSchema = z
	.object({
		goal: text,
		acceptanceCriteria: z.array(taskStateRecordSchema).max(100),
		constraints: z.array(taskStateRecordSchema).max(100),
		decisions: z.array(taskStateRecordSchema).max(100),
		workItems: z.array(taskStateWorkItemSchema).max(100),
		evidenceRefs: z.array(taskStateEvidenceSchema).max(200),
		failedApproaches: z.array(taskStateRecordSchema).max(100),
		blockers: z.array(taskStateRecordSchema).max(100),
		nextAction: text,
	})
	.strict()
export type TaskStateData = z.infer<typeof taskStateDataSchema>
export type TaskStateEvidence = z.infer<typeof taskStateEvidenceSchema>

const recordCollection = z.enum(["acceptanceCriteria", "constraints", "decisions", "failedApproaches", "blockers"])
const collection = z.enum([
	"acceptanceCriteria",
	"constraints",
	"decisions",
	"failedApproaches",
	"blockers",
	"workItems",
	"evidenceRefs",
])
// Provenance is deliberately absent from model inputs. The store assigns it.
export const taskStatePatchOperationSchema = z.union([
	z.object({ op: z.literal("set"), field: z.enum(["goal", "nextAction"]), value: text }).strict(),
	z.object({ op: z.literal("upsert"), collection: recordCollection, value: taskStateRecordSchema }).strict(),
	z.object({ op: z.literal("upsert"), collection: z.literal("workItems"), value: taskStateWorkItemSchema }).strict(),
	z
		.object({
			op: z.literal("upsert"),
			collection: z.literal("evidenceRefs"),
			value: taskStateRecordSchema.extend({ source: text }).strict(),
		})
		.strict(),
	z.object({ op: z.literal("remove"), collection, id: taskStateIdSchema }).strict(),
])
export const taskStatePatchOperationsSchema = z.array(taskStatePatchOperationSchema).min(1).max(100)
export type TaskStatePatchOperation = z.infer<typeof taskStatePatchOperationSchema>

/** User-owned definitions only. A check describes acceptance; it never grants command permission. */
export const taskStatePolicySchema = z
	.object({
		enabled: z.boolean().default(false),
		/** Independent consent for task-state recall and model edits. */
		recallEnabled: z.boolean().default(true),
		maxSteps: z.number().int().min(1).max(1_000).default(20),
		maxDurationMs: z.number().int().min(1).max(86_400_000).default(900_000),
		maxTokens: z.number().int().min(1).max(10_000_000).default(100_000),
		maxNoProgressSteps: z.number().int().min(1).max(100).default(3),
		checks: z.array(taskStateRecordSchema).max(100).default([]),
	})
	.strict()
export type TaskStatePolicy = z.infer<typeof taskStatePolicySchema>

export const taskStateSnapshotSchema = z
	.object({
		schemaVersion: z.literal(1),
		revision: taskStateDigestSchema,
		sequence: z.number().int().positive(),
		parentRevision: taskStateDigestSchema.nullable(),
		baseRevision: taskStateDigestSchema.nullable(),
		historyAnchor: taskStateDigestSchema,
		/** Number of original (non-generated) messages covered by this snapshot. */
		historyPosition: z.number().int().nonnegative().optional(),
		createdAt: z.string().datetime(),
		actor: z.enum(["user", "model", "runtime"]),
		data: taskStateDataSchema,
		policy: taskStatePolicySchema,
		forkedFrom: z
			.object({
				taskId: taskStateIdSchema,
				workspaceId: taskStateDigestSchema,
				revision: taskStateDigestSchema,
				historyAnchor: taskStateDigestSchema,
			})
			.strict()
			.optional(),
	})
	.strict()
export type TaskStateSnapshot = z.infer<typeof taskStateSnapshotSchema>
export type TaskStateCompletionStatus = "completed" | "blocked" | "incomplete" | "awaiting-approval"

export const taskStateNativeRequestSchema = z
	.object({
		requestId: taskStateIdSchema,
		taskId: taskStateIdSchema,
		action: z.enum([
			"read",
			"initialize",
			"correct",
			"export",
			"configure",
			"disable",
			"fresh-context",
			"start",
			"stop",
			"attest",
			"fork",
		]),
		expectedRevision: taskStateDigestSchema.nullable(),
		operations: taskStatePatchOperationsSchema.optional(),
		policy: taskStatePolicySchema.optional(),
		check: z
			.object({
				id: taskStateIdSchema,
				result: z.enum(["passed", "failed"]),
				note: text.refine((value) => value.trim().length > 0),
			})
			.strict()
			.optional(),
		source: z.object({ taskId: taskStateIdSchema, revision: taskStateDigestSchema }).strict().optional(),
	})
	.strict()
export type TaskStateNativeRequest = z.infer<typeof taskStateNativeRequestSchema>
export interface TaskStateNativeResponse {
	requestId: string
	taskId: string
	revision?: string | null
	snapshot?: TaskStateSnapshot | null
	policy?: TaskStatePolicy
	history?: { anchor: string; position: number }
	exportText?: string
	runtime?: {
		armed: boolean
		steps: number
		tokens: number
		elapsedMs: number
		noProgressSteps: number
		status: TaskStateCompletionStatus
		reason: string
		checks: Array<{ id: string; result: "passed" | "failed"; note: string; provenance: "user_attested" }>
	}
	error?: string
}
