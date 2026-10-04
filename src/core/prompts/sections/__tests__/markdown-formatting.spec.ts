import { markdownFormattingSection } from "../markdown-formatting"

describe("default technical writing policy", () => {
	it("includes STE-inspired clarity rules without claiming compliance", () => {
		const section = markdownFormattingSection()
		expect(section).toContain("inspired by Simplified Technical English")
		expect(section).toContain("not a claim of ASD-STE100 compliance or guaranteed correctness")
		expect(section).toContain("Lead with the answer, result, or required action")
		expect(section).toContain("one main idea")
		expect(section).toContain("Prefer active voice")
		expect(section).toContain("one action per numbered step")
		expect(section).toContain("warnings before the action")
	})

	it("preserves requested depth, language, uncertainty, and important detail", () => {
		const section = markdownFormattingSection()
		expect(section).toContain("provide the requested depth")
		expect(section).toContain("Do not impose a fixed sentence or response length limit")
		expect(section).toContain("user's requested language and format")
		expect(section).toContain("do not force English")
		expect(section).toContain("reasoning, evidence, risks, exceptions, or recovery steps")
		expect(section).toContain("State uncertainty and verification limits explicitly")
		expect(section).toContain("Built, installed, activated, and published are different states")
	})

	it("protects executable content and avoids routine progress narration", () => {
		const section = markdownFormattingSection()
		expect(section).toContain(
			"not code, commands, file paths, API identifiers, tool arguments, schemas, or log output",
		)
		expect(section).toContain("Reproduce existing code, logs, and quotations verbatim")
		expect(section).toContain("Do not narrate every routine inspection")
		expect(section).toContain("ALL responses MUST show ANY")
		expect(section).toContain("relative/file/path.ext:line")
	})
})
