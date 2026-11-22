// npx vitest run core/task/parallel/__tests__/new-tasks-gating.spec.ts
//
// B3 schema gating (ADR-2026-11-22-parallel-subtasks rule 1): `new_tasks` is in the tool schema only
// when the experiment is on AND (orchestrator OR cordis/hybrid) AND the task is not a parallel child.
// Validation uses the same inputs, so a filtered-out tool is also refused at execution time.

import { applyProfileToToolInputs, isParallelSubtasksToolOffered } from "../../cordis-profile"
import { filterNativeToolsForMode } from "../../../prompts/tools/filter-tools-for-mode"
import { getNativeTools } from "../../../prompts/tools/native-tools"
import { validateToolUse } from "../../../tools/validateToolUse"
import { checkAutoApproval } from "../../../auto-approval"
import type { TaskProfile } from "@roo-code/types"

const ON = { parallelSubtasks: true }
const OFF = { parallelSubtasks: false }

function schemaNames(
	profile: TaskProfile,
	mode: string,
	experiments: Record<string, boolean> | undefined,
	nonInteractive = false,
): string[] {
	const inputs = applyProfileToToolInputs(profile, mode, undefined, undefined, { experiments, nonInteractive })
	return filterNativeToolsForMode(getNativeTools(), mode, inputs.customModes, experiments, undefined, {
		disabledTools: inputs.disabledTools,
	}).map((tool) => (tool as any).function.name)
}

function requirements(disabledTools?: string[]): Record<string, boolean> {
	return Object.fromEntries((disabledTools ?? []).map((tool) => [tool, false]))
}

describe("new_tasks schema gating", () => {
	it("is absent with the experiment off in every profile and mode", () => {
		for (const profile of ["modes", "cordis", "hybrid"] as const) {
			for (const mode of ["orchestrator", "code", "architect"]) {
				expect(schemaNames(profile, mode, OFF)).not.toContain("new_tasks")
				expect(schemaNames(profile, mode, undefined)).not.toContain("new_tasks")
			}
		}
	})

	it("is present in orchestrator mode in every profile when the experiment is on", () => {
		for (const profile of ["modes", "cordis", "hybrid"] as const) {
			expect(schemaNames(profile, "orchestrator", ON)).toContain("new_tasks")
		}
	})

	it("is present in cordis and hybrid tasks in any mode, absent in modes tasks outside orchestrator", () => {
		expect(schemaNames("cordis", "code", ON)).toContain("new_tasks")
		expect(schemaNames("hybrid", "architect", ON)).toContain("new_tasks")
		expect(schemaNames("modes", "code", ON)).not.toContain("new_tasks")
		expect(schemaNames("modes", "architect", ON)).not.toContain("new_tasks")
	})

	it("is absent in a parallel child even when the experiment is on", () => {
		for (const profile of ["modes", "cordis", "hybrid"] as const) {
			expect(schemaNames(profile, "orchestrator", ON, true)).not.toContain("new_tasks")
			expect(schemaNames(profile, "code", ON, true)).not.toContain("new_tasks")
		}
	})

	it("does not change new_task availability", () => {
		expect(schemaNames("modes", "code", OFF)).toContain("new_task")
		expect(schemaNames("cordis", "code", ON, true)).toContain("new_task")
	})

	it("validation refuses new_tasks whenever the schema omits it", () => {
		const validate = (profile: TaskProfile, mode: string, experiments: Record<string, boolean>, child = false) => {
			const inputs = applyProfileToToolInputs(profile, mode, undefined, undefined, {
				experiments,
				nonInteractive: child,
			})
			return () =>
				validateToolUse(
					"new_tasks",
					mode,
					inputs.customModes ?? [],
					requirements(inputs.disabledTools),
					{ tasks: "[]" },
					experiments,
				)
		}
		expect(validate("modes", "orchestrator", OFF)).toThrow()
		expect(validate("modes", "code", ON)).toThrow()
		expect(validate("cordis", "code", ON, true)).toThrow()
		expect(validate("modes", "orchestrator", ON)).not.toThrow()
		expect(validate("hybrid", "code", ON)).not.toThrow()
	})

	it("isParallelSubtasksToolOffered requires every condition", () => {
		const base = { experiments: ON, nonInteractive: false, mode: "orchestrator", profile: "modes" as const }
		expect(isParallelSubtasksToolOffered(base)).toBe(true)
		expect(isParallelSubtasksToolOffered({ ...base, experiments: OFF })).toBe(false)
		expect(isParallelSubtasksToolOffered({ ...base, experiments: null })).toBe(false)
		expect(isParallelSubtasksToolOffered({ ...base, nonInteractive: true })).toBe(false)
		expect(isParallelSubtasksToolOffered({ ...base, mode: "code" })).toBe(false)
		expect(isParallelSubtasksToolOffered({ ...base, mode: "code", profile: "cordis" })).toBe(true)
	})
})

describe("newTasks auto-approval follows the new_task rule", () => {
	const base = {
		autoApprovalEnabled: true,
		alwaysAllowAll: false,
		alwaysAllowSubtasks: false,
		alwaysAllowReadOnly: true,
		alwaysAllowWrite: true,
		alwaysAllowModeSwitch: true,
	}
	const newTasks = JSON.stringify({ tool: "newTasks", tasks: [], concurrency: 2, tokenBudget: 2_000_000 })
	const newTask = JSON.stringify({ tool: "newTask", mode: "code", content: "x" })

	it.each([
		[{ ...base }, "ask"],
		[{ ...base, alwaysAllowSubtasks: true }, "approve"],
		[{ ...base, alwaysAllowSubtasks: true, autoApprovalEnabled: false }, "ask"],
		[{ ...base, alwaysAllowAll: true }, "approve"],
		[{ ...base, alwaysAllowAll: true, autoApprovalEnabled: false }, "ask"],
	])("state %o gives %s for both newTask and newTasks", async (state, decision) => {
		expect(await checkAutoApproval({ state: state as any, ask: "tool", text: newTasks })).toEqual({ decision })
		expect(await checkAutoApproval({ state: state as any, ask: "tool", text: newTask })).toEqual({ decision })
	})
})
