import {
	CHILD_HANDOFF_GUIDANCE,
	EXECUTION_FOCUS_GUIDANCE,
	PARENT_HANDOFF_GUIDANCE,
	formatSubtaskHandoff,
} from "../subtask-handoff"
import attemptCompletion from "../../prompts/tools/native-tools/attempt_completion"
import newTask from "../../prompts/tools/native-tools/new_task"
import { getToolUseGuidelinesSection } from "../../prompts/sections/tool-use-guidelines"

describe("subtask context handoffs", () => {
	it("exposes direct implementation and focused validation guidance to the model", () => {
		expect(getToolUseGuidelinesSection()).toContain(EXECUTION_FOCUS_GUIDANCE)
		expect(newTask.function.description).toContain(EXECUTION_FOCUS_GUIDANCE)
		for (const phrase of [
			"Prefer direct implementation",
			"only when genuinely needed",
			"task size alone does not require delegation",
			"required by the user or project rules",
			"Choose the smallest relevant check",
			"Reuse valid results from the current code state",
			"a mandatory gate requires it",
			"Stop when the requested deliverable and required validation are complete",
		])
			expect(EXECUTION_FOCUS_GUIDANCE).toContain(phrase)
		expect(newTask.function.description).toContain("minimum necessary additional validation")
	})

	it("requires actionable file references and conclusions rather than a bare completion", () => {
		for (const section of [
			"Outcome:",
			"Changes and findings:",
			"Parent must check:",
			"Validation:",
			"Remaining work:",
		]) {
			expect(CHILD_HANDOFF_GUIDANCE).toContain(section)
		}
		expect(CHILD_HANDOFF_GUIDANCE).toContain("what it contains, why it matters, and exactly what to read or verify")
		expect(CHILD_HANDOFF_GUIDANCE).toContain("file references supplement rather than replace essential information")
		expect(CHILD_HANDOFF_GUIDANCE).toContain("future subtasks should not repeat")
		expect(CHILD_HANDOFF_GUIDANCE).toContain("never invent paths or expose secrets")
		expect(CHILD_HANDOFF_GUIDANCE).toContain("read-only assignment does not authorize creating handoff files")
	})

	it("includes consistent guidance in system, delegation, and completion prompts", () => {
		for (const description of [
			getToolUseGuidelinesSection(),
			newTask.function.description,
			attemptCompletion.function.description,
		]) {
			expect(description).toContain(CHILD_HANDOFF_GUIDANCE)
		}
		expect(getToolUseGuidelinesSection()).toContain(PARENT_HANDOFF_GUIDANCE)
		expect(newTask.function.description).toContain(PARENT_HANDOFF_GUIDANCE)
		expect(PARENT_HANDOFF_GUIDANCE).toContain("self-contained brief")
		expect(PARENT_HANDOFF_GUIDANCE).toContain("do-not-repeat work")
		expect(PARENT_HANDOFF_GUIDANCE).toContain(
			"do not override user constraints, permissions, or approval requirements",
		)
	})

	it("preserves the complete result and puts the parent checklist before it", () => {
		const result = `Outcome: partial\nParent must check: src/example.ts:12 - verify the caller.\n${"Evidence\n".repeat(3000)}Remaining work: rerun integration tests.`
		const handoff = formatSubtaskHandoff("child-42", result)
		expect(handoff).toBe(`Subtask child-42 completed.\n\n${PARENT_HANDOFF_GUIDANCE}\n\nResult:\n${result}`)
		expect(handoff.endsWith(result)).toBe(true)
	})
})
