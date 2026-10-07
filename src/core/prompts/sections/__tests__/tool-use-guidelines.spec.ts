import { getToolUseGuidelinesSection } from "../tool-use-guidelines"

describe("getToolUseGuidelinesSection", () => {
	it("supports implementation children with clear ownership and preserves the nested opt-in boundary", () => {
		const guidelines = getToolUseGuidelinesSection()
		expect(guidelines).toContain("bounded implementation and testing in code mode")
		expect(guidelines).toContain("clear file ownership to avoid conflicting edits")
		expect(guidelines).toContain("caller constraints")
		expect(guidelines).toContain("unless nested-subtask auto approval is explicitly enabled")
		expect(guidelines).toContain(
			"Ordinary subtask or all-actions auto approval alone does not permit deeper auto approval",
		)
	})

	it("should include proper numbered guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("1. Assess what information")
		expect(guidelines).toContain("2. Choose the most appropriate tool")
		expect(guidelines).toContain("3. If multiple actions are needed")
	})

	it("should include multiple-tools-per-message guidance", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("you may use multiple tools in a single message")
		expect(guidelines).not.toContain("use one tool at a time per message")
	})

	it("should use simplified footer without step-by-step language", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).toContain("carefully considering the user's response after tool executions")
		expect(guidelines).not.toContain("It is crucial to proceed step-by-step")
		expect(guidelines).not.toContain("ALWAYS wait for user confirmation after each tool use")
	})

	it("should include common guidance", () => {
		const guidelines = getToolUseGuidelinesSection()
		expect(guidelines).toContain("Assess what information you already have")
		expect(guidelines).toContain("Choose the most appropriate tool")
		expect(guidelines).not.toContain("<actual_tool_name>")
	})

	it("guides research toward bounded fallback retrieval and traceable local evidence", () => {
		const guidelines = getToolUseGuidelinesSection()
		expect(guidelines).toContain("change the retrieval method")
		expect(guidelines).toContain("research/<task-topic>/")
		expect(guidelines).toContain("shallow clone or a pinned source archive")
		expect(guidelines).toContain("connection and total time limits")
		expect(guidelines).toContain("repository commit/tag or paper identifier/version")
		expect(guidelines).toContain("Never use a shell or download to bypass a denied tool action")
		expect(guidelines).toContain("Do not execute downloaded code")
		expect(guidelines).toContain("do not commit them or change ignore rules without authorization")
	})

	it("should not include per-tool confirmation guidelines", () => {
		const guidelines = getToolUseGuidelinesSection()

		expect(guidelines).not.toContain("After each tool use, the user will respond with the result")
	})
})
