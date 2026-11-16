import { applyProfileToToolInputs, CORDIS_GROUPS, resolveTaskProfile } from "../cordis-profile"
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
		expect(resolveTaskProfile({})).toBe("modes")
	})
})

describe("applyProfileToToolInputs", () => {
	it("returns inputs unchanged for the modes profile", () => {
		const customModes: any[] = []
		const disabledTools = ["browser_action"]
		const result = applyProfileToToolInputs("modes", "architect", customModes, disabledTools)
		expect(result.customModes).toBe(customModes)
		expect(result.disabledTools).toBe(disabledTools)
	})

	it("gives the mode all groups without file restrictions and disables switch_mode", () => {
		const result = applyProfileToToolInputs("cordis", "architect", undefined, ["browser_action"])
		const mode = getModeBySlug("architect", result.customModes)
		expect(mode?.groups).toEqual([...CORDIS_GROUPS])
		expect(mode?.roleDefinition).toBe(getModeBySlug("architect")?.roleDefinition)
		expect(result.disabledTools).toEqual(expect.arrayContaining(["browser_action", "switch_mode"]))
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
})
