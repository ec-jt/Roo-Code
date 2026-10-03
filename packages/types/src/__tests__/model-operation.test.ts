import type { ZodType } from "zod"

import {
	modelOperationSchema,
	modelOperationApprovalSchema,
	modelOperationStatusSchema,
	modelOperationStateSchema,
	type ModelOperation,
	type ModelOperationApproval,
	type ModelOperationStatus,
	type ModelOperationState,
	type WebviewMessage,
	type ExtensionMessage,
	type ExtensionState,
} from "../index.js"

const operation = {
	operationId: "operation-1",
	kind: "regenerate",
	taskId: "task-1",
	instanceId: "instance-1",
	revision: 0,
	profileId: "profile-1",
	confirmCurrentWorkspace: false,
} satisfies ModelOperation

const approval = {
	taskId: "task-1",
	instanceId: "instance-1",
	revision: 0,
	approvalId: "approval-1",
	approved: false,
} satisfies ModelOperationApproval

const status = {
	operationId: "operation-1",
	status: "running",
	message: "Changing model",
} satisfies ModelOperationStatus

const state = {
	taskId: "task-1",
	instanceId: "instance-1",
	revision: 0,
	readiness: "ready",
	requiresToolApproval: false,
} satisfies ModelOperationState

const schemaCases: {
	name: string
	schema: ZodType
	value: Record<string, unknown>
	identityFields: string[]
	booleanField?: string
}[] = [
	{
		name: "operation",
		schema: modelOperationSchema,
		value: operation,
		identityFields: ["operationId", "taskId", "instanceId", "profileId", "requestId"],
		booleanField: "confirmCurrentWorkspace",
	},
	{
		name: "approval",
		schema: modelOperationApprovalSchema,
		value: approval,
		identityFields: ["taskId", "instanceId", "approvalId"],
		booleanField: "approved",
	},
	{
		name: "status",
		schema: modelOperationStatusSchema,
		value: status,
		identityFields: ["operationId", "taskId", "instanceId"],
	},
	{
		name: "state",
		schema: modelOperationStateSchema,
		value: state,
		identityFields: ["taskId", "instanceId", "requestId", "profileId"],
		booleanField: "requiresToolApproval",
	},
]

describe.each(schemaCases)("model operation $name schema", ({ schema, value, identityFields, booleanField }) => {
	it("accepts the minimal payload without adding defaults", () => {
		expect(schema.parse(value)).toEqual(value)
	})

	it("requires every mandatory field", () => {
		for (const field of Object.keys(value)) {
			const incomplete = { ...value }
			delete incomplete[field]
			expect(schema.safeParse(incomplete).success, field).toBe(false)
		}
	})

	it("rejects unknown fields", () => {
		expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false)
	})

	it.each([null, undefined, [], "payload", 1])("rejects a non-object payload: %s", (invalid) => {
		expect(schema.safeParse(invalid).success).toBe(false)
	})

	it.each(["", " ", "\t\n", "\u00a0", null, 1, false])("rejects invalid identities: %s", (invalid) => {
		for (const field of identityFields) {
			expect(schema.safeParse({ ...value, [field]: invalid }).success, field).toBe(false)
		}
	})

	it("preserves identity strings without normalization", () => {
		for (const field of identityFields) {
			expect(schema.parse({ ...value, [field]: " identity " })).toEqual({ ...value, [field]: " identity " })
		}
	})

	it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts safe nonnegative revision %s", (revision) => {
		expect(schema.parse({ ...value, revision })).toEqual({ ...value, revision })
	})

	it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, "1", null])(
		"rejects invalid revision %s",
		(revision) => {
			expect(schema.safeParse({ ...value, revision }).success).toBe(false)
		},
	)

	if (booleanField) {
		it.each([true, false])("accepts boolean %s", (bool) => {
			expect(schema.safeParse({ ...value, [booleanField]: bool }).success).toBe(true)
		})

		it.each(["true", 0, 1, null])("does not coerce boolean %s", (invalid) => {
			expect(schema.safeParse({ ...value, [booleanField]: invalid }).success).toBe(false)
		})
	}
})

describe("model operation protocol", () => {
	it.each(["regenerate", "switch"])("accepts operation kind %s with a request identity", (kind) => {
		const value = { ...operation, kind, requestId: "request-1" }
		expect(modelOperationSchema.parse(value)).toEqual(value)
	})

	it.each(["running", "completed", "blocked", "failed"])("accepts status %s with task context", (value) => {
		const payload = { ...status, status: value, taskId: "task-1", instanceId: "instance-1", revision: 1 }
		expect(modelOperationStatusSchema.parse(payload)).toEqual(payload)
	})

	it.each(["ready", "blocked"])("accepts readiness %s with approval and optional context", (readiness) => {
		const payload = {
			...state,
			readiness,
			requestId: "request-1",
			profileId: "profile-1",
			reason: "Tool approval required",
			requiresToolApproval: true,
			approval: { approvalId: "approval-1", toolName: "read_file" },
		}
		expect(modelOperationStateSchema.parse(payload)).toEqual(payload)
	})

	it("rejects unknown enum values", () => {
		expect(modelOperationSchema.safeParse({ ...operation, kind: "retry" }).success).toBe(false)
		expect(modelOperationStatusSchema.safeParse({ ...status, status: "pending" }).success).toBe(false)
		expect(modelOperationStateSchema.safeParse({ ...state, readiness: "running" }).success).toBe(false)
	})

	it("validates message and reason as strings", () => {
		expect(modelOperationStatusSchema.safeParse({ ...status, message: 1 }).success).toBe(false)
		expect(modelOperationStateSchema.safeParse({ ...state, reason: 1 }).success).toBe(false)
		expect(modelOperationStatusSchema.safeParse({ ...status, message: "" }).success).toBe(true)
		expect(modelOperationStateSchema.safeParse({ ...state, reason: "" }).success).toBe(true)
	})

	it.each([
		null,
		{},
		{ approvalId: "approval-1" },
		{ toolName: "read_file" },
		{ approvalId: "", toolName: "read_file" },
		{ approvalId: " \t", toolName: "read_file" },
		{ approvalId: "approval-1", toolName: "\n" },
		{ approvalId: "approval-1", toolName: "" },
		{ approvalId: 1, toolName: "read_file" },
		{ approvalId: "approval-1", toolName: false },
		{ approvalId: "approval-1", toolName: "read_file", approved: true },
	])("rejects invalid or non-strict nested approval %j", (invalid) => {
		expect(modelOperationStateSchema.safeParse({ ...state, approval: invalid }).success).toBe(false)
	})

	it("keeps approval responses separate from operation requests", () => {
		expect(modelOperationSchema.safeParse(approval).success).toBe(false)
		expect(modelOperationApprovalSchema.safeParse(operation).success).toBe(false)
	})

	it("wires exported payload types into the shared message and state contracts", () => {
		const operationMessage: WebviewMessage = { type: "modelOperation", modelOperation: operation }
		const approvalMessage: WebviewMessage = { type: "modelOperationApproval", modelOperationApproval: approval }
		const statusMessage: ExtensionMessage = { type: "modelOperationStatus", modelOperationStatus: status }
		const extensionState: Partial<ExtensionState> = { modelOperation: state }
		const stateMessage: ExtensionMessage = { type: "state", state: extensionState }

		expect(modelOperationSchema.parse(operationMessage.modelOperation)).toEqual(operation)
		expect(modelOperationApprovalSchema.parse(approvalMessage.modelOperationApproval)).toEqual(approval)
		expect(modelOperationStatusSchema.parse(statusMessage.modelOperationStatus)).toEqual(status)
		expect(modelOperationStateSchema.parse(stateMessage.state?.modelOperation)).toEqual(state)
	})
})
