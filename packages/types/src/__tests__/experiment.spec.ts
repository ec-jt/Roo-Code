import { experimentIdsSchema, experimentsSchema } from "../experiment.js"

describe("Cordis runtime preview settings", () => {
	it("accepts persisted opt-in and opt-out", () => {
		expect(experimentIdsSchema.parse("cordisRuntimePreview")).toBe("cordisRuntimePreview")
		for (const enabled of [true, false]) {
			expect(experimentsSchema.parse({ cordisRuntimePreview: enabled })).toEqual({
				cordisRuntimePreview: enabled,
			})
		}
	})

	it("keeps old and absent settings opted out without a migration", () => {
		expect(experimentsSchema.parse({}).cordisRuntimePreview).toBeUndefined()
		expect(experimentsSchema.parse({ customTools: true })).toEqual({ customTools: true })
		expect(experimentsSchema.safeParse({ cordisRuntimePreview: "true" }).success).toBe(false)
	})
})
