import {
	applyProfileToToolInputs,
	CORDIS_GROUPS,
	effectiveProfileSetting,
	hasPlanReview,
	resolveTaskProfile,
} from "../cordis-profile"
import { validateToolUse } from "../../tools/validateToolUse"
import { getModeBySlug } from "../../../shared/modes"

function requirements(disabledTools?: string[]): Record<string, boolean> {
	return Object.fromEntries((disabledTools ?? []).map((tool) => [tool, false]))
}

describe("resolveTaskProfile", () => {
	it("prefers the stored profile over parent and experiment", () => {
		expect(
			resolveTaskProfile({ stored: "modes", parent: "cordis", experiments: { cordisRuntimePreview: true } }),
		).toBe("modes")
		expect(resolveTaskProfile({ stored: "cordis", experiments: {} })).toBe("cordis")
	})

	it("inherits the parent profile when no stored profile exists", () => {
		expect(resolveTaskProfile({ parent: "cordis", experiments: { cordisRuntimePreview: false } })).toBe("cordis")
		expect(resolveTaskProfile({ parent: "modes", experiments: { cordisRuntimePreview: true } })).toBe("modes")
	})

	it("uses the experiment flag for new root tasks", () => {
		expect(resolveTaskProfile({ experiments: { cordisRuntimePreview: true } })).toBe("cordis")
		expect(resolveTaskProfile({ experiments: { cordisRuntimePreview: false } })).toBe("modes")
	})

	it("gives a new root task modes when nothing is stored (ADR-2026-11-23-modes-default-profile)", () => {
		expect(resolveTaskProfile({})).toBe("modes")
		expect(resolveTaskProfile({ experiments: {} })).toBe("modes")
		expect(resolveTaskProfile({ experiments: { customTools: true } })).toBe("modes")
		expect(resolveTaskProfile({ experiments: { cordisRuntimePreview: undefined } })).toBe("modes")
	})

	it("gives cordis only for a stored cordisRuntimePreview: true without a taskProfile", () => {
		expect(resolveTaskProfile({ setting: undefined, experiments: { cordisRuntimePreview: true } })).toBe("cordis")
		expect(resolveTaskProfile({ setting: "bogus", experiments: { cordisRuntimePreview: true } })).toBe("cordis")
	})

	it("lets a stored taskProfile win over every other setting", () => {
		for (const setting of ["modes", "cordis", "hybrid"] as const) {
			for (const experiments of [
				undefined,
				{},
				{ cordisRuntimePreview: true },
				{ cordisRuntimePreview: false },
			]) {
				expect(resolveTaskProfile({ setting, experiments })).toBe(setting)
			}
		}
	})

	it("keeps stored and parent profiles ahead of the default", () => {
		expect(resolveTaskProfile({ stored: "modes", experiments: {} })).toBe("modes")
		expect(resolveTaskProfile({ stored: "modes" })).toBe("modes")
		expect(resolveTaskProfile({ parent: "modes", experiments: {} })).toBe("modes")
		expect(resolveTaskProfile({ parent: "modes" })).toBe("modes")
	})

	it("resolves hybrid from stored, parent and setting", () => {
		expect(resolveTaskProfile({ stored: "hybrid", parent: "cordis", setting: "modes" })).toBe("hybrid")
		expect(resolveTaskProfile({ parent: "hybrid", setting: "cordis" })).toBe("hybrid")
		expect(resolveTaskProfile({ setting: "hybrid", experiments: { cordisRuntimePreview: false } })).toBe("hybrid")
	})

	it("prefers a valid taskProfile setting over the legacy flag", () => {
		expect(resolveTaskProfile({ setting: "modes", experiments: { cordisRuntimePreview: true } })).toBe("modes")
		expect(resolveTaskProfile({ setting: "cordis", experiments: { cordisRuntimePreview: false } })).toBe("cordis")
	})

	it("falls back to the legacy flag when the setting is absent or invalid", () => {
		expect(resolveTaskProfile({ setting: undefined, experiments: { cordisRuntimePreview: false } })).toBe("modes")
		expect(resolveTaskProfile({ setting: "bogus", experiments: { cordisRuntimePreview: false } })).toBe("modes")
		expect(resolveTaskProfile({ setting: "bogus", experiments: {} })).toBe("modes")
	})

	it("gives modes for an unknown stored value", () => {
		expect(resolveTaskProfile({ stored: "future-profile", parent: "cordis", setting: "hybrid" })).toBe("modes")
		expect(resolveTaskProfile({ stored: null, setting: "cordis" })).toBe("modes")
	})
})

describe("effectiveProfileSetting and hasPlanReview", () => {
	it("maps the legacy flag and never needs to rewrite it", () => {
		const experiments = { cordisRuntimePreview: false }
		expect(effectiveProfileSetting(undefined, experiments)).toBe("modes")
		expect(experiments).toEqual({ cordisRuntimePreview: false })
		expect(effectiveProfileSetting(undefined, { cordisRuntimePreview: true })).toBe("cordis")
		expect(effectiveProfileSetting(undefined, undefined)).toBe("modes")
		expect(effectiveProfileSetting(undefined, null)).toBe("modes")
		expect(effectiveProfileSetting(undefined, {})).toBe("modes")
		const stored = { cordisRuntimePreview: true }
		expect(effectiveProfileSetting(undefined, stored)).toBe("cordis")
		expect(stored).toEqual({ cordisRuntimePreview: true })
		expect(effectiveProfileSetting("hybrid", { cordisRuntimePreview: false })).toBe("hybrid")
	})

	it("is true for cordis and hybrid only", () => {
		expect(hasPlanReview("cordis")).toBe(true)
		expect(hasPlanReview("hybrid")).toBe(true)
		expect(hasPlanReview("modes")).toBe(false)
		expect(hasPlanReview(undefined)).toBe(false)
	})
})

describe("applyProfileToToolInputs", () => {
	it("keeps custom modes for the modes profile and disables only the Cordis-only tools", () => {
		const customModes: any[] = []
		const disabledTools = ["browser_action"]
		const result = applyProfileToToolInputs("modes", "architect", customModes, disabledTools)
		expect(result.customModes).toBe(customModes)
		// new_tasks is disabled too: without options the parallelSubtasks experiment counts as off.
		expect(result.disabledTools).toEqual(["browser_action", "exit_plan", "new_tasks"])
		expect(disabledTools).toEqual(["browser_action"])
	})

	it("admits exit_plan for the cordis profile", () => {
		const result = applyProfileToToolInputs("cordis", "code", undefined, ["browser_action"])
		expect(result.disabledTools).not.toContain("exit_plan")
	})

	it("gives the mode all groups without file restrictions and disables switch_mode", () => {
		const result = applyProfileToToolInputs("cordis", "architect", undefined, ["browser_action"])
		const mode = getModeBySlug("architect", result.customModes)
		expect(mode?.groups).toEqual([...CORDIS_GROUPS])
		expect(mode?.roleDefinition).toBe(getModeBySlug("architect")?.roleDefinition)
		expect(result.disabledTools).toEqual(expect.arrayContaining(["browser_action", "switch_mode"]))
	})

	it("keeps mode groups, switch_mode and exit_plan for the hybrid profile", () => {
		const customModes: any[] = []
		const disabledTools = ["browser_action"]
		const result = applyProfileToToolInputs("hybrid", "architect", customModes, disabledTools)
		expect(result.customModes).toBe(customModes)
		expect(getModeBySlug("architect", result.customModes)?.groups).toEqual(getModeBySlug("architect")?.groups)
		expect(result.disabledTools).toEqual(["browser_action", "new_tasks"])
		expect(
			applyProfileToToolInputs("hybrid", "architect", customModes, disabledTools, {
				experiments: { parallelSubtasks: true },
			}).disabledTools,
		).toBe(disabledTools)
		expect(result.disabledTools).not.toContain("switch_mode")
		expect(result.disabledTools).not.toContain("exit_plan")
	})

	it("replaces an existing custom mode with the same slug", () => {
		const custom = [{ slug: "mine", name: "Mine", roleDefinition: "r", groups: ["read"] }] as any
		const result = applyProfileToToolInputs("cordis", "mine", custom, undefined)
		expect((result.customModes ?? []).filter((m) => m.slug === "mine")).toHaveLength(1)
		expect(getModeBySlug("mine", result.customModes)?.groups).toEqual([...CORDIS_GROUPS])
	})
})

describe("Cordis profile execution-time validation", () => {
	it("blocks commands and non-Markdown writes in Architect under the modes profile", () => {
		const inputs = applyProfileToToolInputs("modes", "architect", [], [])
		expect(() =>
			validateToolUse("execute_command", "architect", inputs.customModes, requirements(inputs.disabledTools), {
				command: "ls",
			}),
		).toThrow()
		expect(() =>
			validateToolUse("write_to_file", "architect", inputs.customModes, requirements(inputs.disabledTools), {
				path: "src/a.ts",
				content: "x",
			}),
		).toThrow()
	})

	it("allows commands and any file writes in Architect under the cordis profile", () => {
		const inputs = applyProfileToToolInputs("cordis", "architect", [], [])
		expect(() =>
			validateToolUse("execute_command", "architect", inputs.customModes, requirements(inputs.disabledTools), {
				command: "ls",
			}),
		).not.toThrow()
		expect(() =>
			validateToolUse("write_to_file", "architect", inputs.customModes, requirements(inputs.disabledTools), {
				path: "src/a.ts",
				content: "x",
			}),
		).not.toThrow()
	})

	it("rejects switch_mode under the cordis profile only", () => {
		const modes = applyProfileToToolInputs("modes", "code", [], [])
		expect(() =>
			validateToolUse("switch_mode", "code", modes.customModes, requirements(modes.disabledTools), {
				mode_slug: "ask",
			}),
		).not.toThrow()
		const cordis = applyProfileToToolInputs("cordis", "code", [], [])
		expect(() =>
			validateToolUse("switch_mode", "code", cordis.customModes, requirements(cordis.disabledTools), {
				mode_slug: "ask",
			}),
		).toThrow()
	})

	it("keeps per-mode limits, switch_mode and exit_plan in every mode under the hybrid profile", () => {
		const architect = applyProfileToToolInputs("hybrid", "architect", [], [])
		expect(() =>
			validateToolUse(
				"execute_command",
				"architect",
				architect.customModes,
				requirements(architect.disabledTools),
				{
					command: "ls",
				},
			),
		).toThrow()
		expect(() =>
			validateToolUse(
				"write_to_file",
				"architect",
				architect.customModes,
				requirements(architect.disabledTools),
				{
					path: "src/a.ts",
					content: "x",
				},
			),
		).toThrow()
		for (const mode of ["code", "architect", "ask", "debug", "orchestrator"]) {
			const hybrid = applyProfileToToolInputs("hybrid", mode, [], [])
			expect(() =>
				validateToolUse("switch_mode", mode, hybrid.customModes, requirements(hybrid.disabledTools), {
					mode_slug: "code",
				}),
			).not.toThrow()
			expect(() =>
				validateToolUse("exit_plan", mode, hybrid.customModes, requirements(hybrid.disabledTools), {
					plan: "# Plan",
				}),
			).not.toThrow()
		}
	})

	it("rejects exit_plan under the modes profile and admits it under the cordis profile", () => {
		const modes = applyProfileToToolInputs("modes", "code", [], [])
		expect(() =>
			validateToolUse("exit_plan", "code", modes.customModes, requirements(modes.disabledTools), {
				plan: "# Plan",
			}),
		).toThrow()
		for (const mode of ["code", "architect", "ask"]) {
			const cordis = applyProfileToToolInputs("cordis", mode, [], [])
			expect(() =>
				validateToolUse("exit_plan", mode, cordis.customModes, requirements(cordis.disabledTools), {
					plan: "# Plan",
				}),
			).not.toThrow()
		}
	})
})
