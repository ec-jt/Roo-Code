import { globalSettingsSchema } from "../global-settings.js"

describe("nested-subtask auto-approval setting", () => {
	it("remains absent by default instead of silently enabling nested auto approval", () => {
		expect(globalSettingsSchema.parse({}).alwaysAllowNestedSubtasks).toBeUndefined()
	})

	it.each([false, true])("preserves an explicit opt-in value of %s", (value) => {
		expect(globalSettingsSchema.parse({ alwaysAllowNestedSubtasks: value }).alwaysAllowNestedSubtasks).toBe(value)
	})

	it.each(["true", 1, null])("rejects nonboolean values: %s", (value) => {
		expect(globalSettingsSchema.safeParse({ alwaysAllowNestedSubtasks: value }).success).toBe(false)
	})
})
