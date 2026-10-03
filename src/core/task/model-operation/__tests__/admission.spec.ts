import { type ModelOperationApproval } from "@roo-code/types"

import { ModelOperationAdmission } from "../admission"

describe("ModelOperationAdmission", () => {
	let identity: { taskId: string; instanceId: string; revision: number }
	let onChange: ReturnType<typeof vi.fn>
	let admission: ModelOperationAdmission

	const response = (approved = true): ModelOperationApproval => ({
		...identity,
		approvalId: admission.pending!.approvalId,
		approved,
	})

	beforeEach(() => {
		identity = { taskId: "task", instanceId: "instance", revision: 1 }
		onChange = vi.fn()
		admission = new ModelOperationAdmission(() => identity, onChange)
	})

	it("admits nonmandatory calls without creating an approval", async () => {
		expect(admission.requiresApproval).toBe(false)
		await expect(admission.request("write_to_file", "call")).resolves.toBe(true)
		await expect(admission.request("new_task", "child")).resolves.toBe(true)
		expect(admission.pending).toBeUndefined()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("publishes pending and resolved state and consumes approval exactly once", async () => {
		admission.requiresApproval = true
		const states: unknown[] = []
		onChange.mockImplementation(() => states.push(admission.pending))
		const request = admission.request("write_to_file", "call")
		const payload = response()
		expect(states).toEqual([{ approvalId: payload.approvalId, toolName: "write_to_file" }])
		expect(admission.respond(payload)).toBe(true)
		await expect(request).resolves.toBe(true)
		expect(states).toEqual([{ approvalId: payload.approvalId, toolName: "write_to_file" }, undefined])
		expect(admission.respond(payload)).toBe(false)
		expect(onChange).toHaveBeenCalledTimes(2)
	})

	it("accepts rejection as a consumed response and resolves false", async () => {
		admission.requiresApproval = true
		const request = admission.request("execute_command", "call")
		const payload = response(false)
		expect(admission.respond(payload)).toBe(true)
		await expect(request).resolves.toBe(false)
		expect(admission.respond(payload)).toBe(false)
		expect(admission.pending).toBeUndefined()
		expect(onChange).toHaveBeenCalledTimes(2)
	})

	it.each([
		{ taskId: "other-task" },
		{ instanceId: "other-instance" },
		{ revision: 2 },
		{ approvalId: "other-approval" },
	])("rejects mismatched identity or approval %j without consuming the request", async (override) => {
		admission.requiresApproval = true
		const request = admission.request("read_file", "call")
		const payload = response()
		expect(admission.respond({ ...payload, ...override })).toBe(false)
		expect(admission.pending?.approvalId).toBe(payload.approvalId)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(admission.respond(payload)).toBe(true)
		await expect(request).resolves.toBe(true)
	})

	it.each([
		null,
		undefined,
		{},
		{ approved: "true" },
		{ approved: undefined },
		{ extra: true },
		{ revision: -1 },
		{ revision: 1.5 },
		{ revision: Number.MAX_SAFE_INTEGER + 1 },
		{ taskId: "" },
		{ instanceId: "" },
		{ approvalId: "" },
	])("validates responses with the strict shared schema: %j", async (invalid) => {
		admission.requiresApproval = true
		const request = admission.request("read_file", "call")
		const payload = response()
		const malformed = invalid && Object.keys(invalid).length ? { ...payload, ...invalid } : invalid
		expect(admission.respond(malformed)).toBe(false)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(admission.respond(payload)).toBe(true)
		await expect(request).resolves.toBe(true)
	})

	it("cancels pending approval once and rejects late responses", async () => {
		admission.requiresApproval = true
		admission.cancel()
		expect(onChange).not.toHaveBeenCalled()
		const request = admission.request("read_file", "call")
		const payload = response()
		admission.cancel()
		admission.cancel()
		await expect(request).resolves.toBe(false)
		expect(admission.pending).toBeUndefined()
		expect(admission.respond(payload)).toBe(false)
		expect(onChange).toHaveBeenCalledTimes(2)
	})

	it.each(["taskId", "instanceId", "revision"] as const)(
		"fails closed if live %s changes, even when the identity object is mutated",
		async (field) => {
			admission.requiresApproval = true
			const request = admission.request("read_file", "call")
			const payload = response()
			if (field === "revision") {
				identity.revision++
			} else {
				identity[field] += "-changed"
			}
			expect(admission.respond(payload)).toBe(false)
			await expect(request).resolves.toBe(false)
			expect(admission.pending).toBeUndefined()
			expect(onChange).toHaveBeenCalledTimes(2)
		},
	)

	it("does not accept a response using the new live revision for an old request", async () => {
		admission.requiresApproval = true
		const request = admission.request("read_file", "call")
		identity = { ...identity, revision: 2 }
		expect(admission.respond(response())).toBe(false)
		await expect(request).resolves.toBe(false)
	})

	it("denies mandatory delegation without publishing an approval", async () => {
		admission.requiresApproval = true
		await expect(admission.request("new_task", "child")).resolves.toBe(false)
		expect(admission.pending).toBeUndefined()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("denies concurrent calls without replacing or sharing the waiting call", async () => {
		admission.requiresApproval = true
		const first = admission.request("read_file", "call")
		const payload = response()
		await expect(admission.request("write_to_file", "other-call")).resolves.toBe(false)
		await expect(admission.request("read_file", "call")).resolves.toBe(false)
		admission.requiresApproval = false
		await expect(admission.request("read_file", "third-call")).resolves.toBe(false)
		expect(admission.pending?.approvalId).toBe(payload.approvalId)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(admission.respond(payload)).toBe(true)
		await expect(first).resolves.toBe(true)
	})

	it("requires fresh approval for every call, even when tool name and ID are reused", async () => {
		admission.requiresApproval = true
		const first = admission.request("read_file", "call")
		const payload = response()
		expect(admission.respond(payload)).toBe(true)
		await expect(first).resolves.toBe(true)
		const second = admission.request("read_file", "call")
		expect(admission.pending?.approvalId).not.toBe(payload.approvalId)
		expect(admission.respond(payload)).toBe(false)
		expect(admission.respond(response(false))).toBe(true)
		await expect(second).resolves.toBe(false)
	})

	it("does not expose mutable pending approval state", async () => {
		admission.requiresApproval = true
		const request = admission.request("read_file", "call")
		const payload = response()
		const pending = admission.pending!
		pending.approvalId = "forged"
		pending.toolName = "new_task"
		expect(admission.pending).toEqual({ approvalId: payload.approvalId, toolName: "read_file" })
		expect(admission.respond(payload)).toBe(true)
		await expect(request).resolves.toBe(true)
	})

	it("does not bank unsolicited approval for a later request", async () => {
		expect(admission.respond({ ...identity, approvalId: "unsolicited", approved: true })).toBe(false)
		admission.requiresApproval = true
		const request = admission.request("read_file", "call")
		expect(admission.pending).toBeDefined()
		admission.cancel()
		await expect(request).resolves.toBe(false)
	})
})
