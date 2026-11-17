import { parsePlanCommand } from "../planCommand"

describe("parsePlanCommand", () => {
	it("parses the plan overlay commands", () => {
		expect(parsePlanCommand("/plan")).toEqual({ on: true })
		expect(parsePlanCommand("  /plan  ")).toEqual({ on: true })
		expect(parsePlanCommand("/plan off")).toEqual({ on: false })
		expect(parsePlanCommand("/plan Design the cache")).toEqual({ on: true, text: "Design the cache" })
		expect(parsePlanCommand("/plan\nline one\nline two")).toEqual({ on: true, text: "line one\nline two" })
	})

	it("ignores other input", () => {
		expect(parsePlanCommand("")).toBeUndefined()
		expect(parsePlanCommand("/planner")).toBeUndefined()
		expect(parsePlanCommand("please /plan this")).toBeUndefined()
		expect(parsePlanCommand("/review")).toBeUndefined()
	})
})
