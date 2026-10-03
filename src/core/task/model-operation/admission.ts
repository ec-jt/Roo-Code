import { randomUUID } from "node:crypto"

import { modelOperationApprovalSchema, type ModelOperationApproval } from "@roo-code/types"

type AdmissionIdentity = Pick<ModelOperationApproval, "taskId" | "instanceId" | "revision">
type PendingApproval = { approvalId: string; toolName: string }

/** One-use approval for a single waiting tool call, independent of ordinary asks. */
export class ModelOperationAdmission {
	public requiresApproval = false

	private waiting?: {
		identity: AdmissionIdentity
		approval: PendingApproval
		resolve: (approved: boolean) => void
	}

	constructor(
		private readonly identity: () => AdmissionIdentity,
		private readonly onChange: () => void,
	) {}

	get pending(): PendingApproval | undefined {
		return this.waiting ? { ...this.waiting.approval } : undefined
	}

	async request(toolName: string, toolId: string): Promise<boolean> {
		// Never replace an outstanding request or let another call share its grant.
		if (this.waiting) {
			return false
		}

		if (!this.requiresApproval) {
			return true
		}

		// Mandatory approval cannot be delegated to a child task.
		if (toolName === "new_task") {
			return false
		}

		const identity = { ...this.identity() }
		const approval = { approvalId: `${toolId}:${randomUUID()}`, toolName }
		const result = new Promise<boolean>((resolve) => {
			this.waiting = { identity, approval, resolve }
		})
		this.onChange()
		return result
	}

	/** Returns whether the response was accepted, not whether it approved the call. */
	respond(payload: unknown): boolean {
		const parsed = modelOperationApprovalSchema.safeParse(payload)
		const waiting = this.waiting
		if (!parsed.success || !waiting) {
			return false
		}

		const live = this.identity()
		if (
			live.taskId !== waiting.identity.taskId ||
			live.instanceId !== waiting.identity.instanceId ||
			live.revision !== waiting.identity.revision
		) {
			this.cancel()
			return false
		}

		const response = parsed.data
		if (
			response.taskId !== waiting.identity.taskId ||
			response.instanceId !== waiting.identity.instanceId ||
			response.revision !== waiting.identity.revision ||
			response.approvalId !== waiting.approval.approvalId
		) {
			return false
		}

		this.settle(response.approved)
		return true
	}

	cancel(): void {
		this.settle(false)
	}

	private settle(approved: boolean): void {
		const waiting = this.waiting
		if (!waiting) {
			return
		}

		this.waiting = undefined
		waiting.resolve(approved)
		this.onChange()
	}
}
