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
	})
})
