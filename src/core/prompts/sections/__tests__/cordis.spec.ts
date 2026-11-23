import { getCordisSection } from "../cordis"

describe("getCordisSection", () => {
	it("is empty for modes tasks", () => {
		expect(getCordisSection("modes", false)).toBe("")
		expect(getCordisSection("modes", true)).toBe("")
		expect(getCordisSection(undefined, true)).toBe("")
	})

	it("contains the drift rule for every Cordis task and the overlay block only when on", () => {
		const off = getCordisSection("cordis", false)
		expect(off).toContain("docs/architecture/")
		expect(off).toContain("call exit_plan with an amendment")
		expect(off).toContain("supersedes any mode instruction")
		expect(off).not.toContain("PLAN OVERLAY")

		const on = getCordisSection("cordis", true)
		expect(on.startsWith(off)).toBe(true)
		expect(on).toContain("PLAN OVERLAY")
		expect(on).toContain("Make no edits except to plan or architecture documents")
	})

	it("is stable for the same task state", () => {
		expect(getCordisSection("cordis", true)).toBe(getCordisSection("cordis", true))
		expect(getCordisSection("cordis", false)).toBe(getCordisSection("cordis", false))
		expect(getCordisSection("hybrid", true)).toBe(getCordisSection("hybrid", true))
	})

	it("hybrid has the exit_plan-in-Architect and drift sections without mode locking", () => {
		const off = getCordisSection("hybrid", false)
		expect(off).toContain("HYBRID TASK")
		expect(off).toContain("Architect mode")
		expect(off).toContain("finish planning by calling exit_plan")
		expect(off).toContain("call exit_plan with an amendment")
		expect(off).toContain("After approval")
		expect(off).not.toContain("mode is fixed")
		expect(off).not.toContain("do not ask to switch modes")
		expect(off).not.toContain("CORDIS TASK")
		expect(off).not.toContain("PLAN OVERLAY")
	})

	it("drift covers stated requirements and the approved plan, not only records (L1 defect 2)", () => {
		for (const profile of ["cordis", "hybrid"] as const) {
			const text = getCordisSection(profile, false)
			expect(text).toContain("requirements stated earlier in this task")
			expect(text).toContain("the approved plan, even when no record exists")
			expect(text).toContain("do not treat the newer message as an override")
			expect(text).toContain("call exit_plan with an amendment that proposes how to resolve the conflict")
		}
	})

	it("the plan overlay asks for records before exit_plan when the layout is missing (L1 defect 2)", () => {
		for (const profile of ["cordis", "hybrid"] as const) {
			const on = getCordisSection(profile, true)
			expect(on).toContain("no docs/architecture/")
			expect(on).toContain(
				"Before calling exit_plan, record the key constraints and decisions of the plan as records",
			)
			expect(on).toContain("cite their IDs in the plan")
			expect(getCordisSection(profile, false)).not.toContain("Before calling exit_plan, record")
		}
	})

	it("hybrid includes the plan overlay when /plan is on", () => {
		const off = getCordisSection("hybrid", false)
		const on = getCordisSection("hybrid", true)
		expect(on.startsWith(off)).toBe(true)
		expect(on).toContain("PLAN OVERLAY (ON)")
		expect(on).not.toContain("mode is fixed")
	})
})
