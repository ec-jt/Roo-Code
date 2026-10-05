import { globalSettingsSchema, GLOBAL_SETTINGS_KEYS } from "../global-settings.js"

describe("local browser settings", () => {
	it("keeps older settings compatible without adding a schema default", () => {
		expect(globalSettingsSchema.parse({}).browserLocalBrowser).toBeUndefined()
		expect(GLOBAL_SETTINGS_KEYS).toContain("browserLocalBrowser")
	})

	it.each(["chromium", "chrome"])("accepts %s", (browserLocalBrowser) => {
		expect(globalSettingsSchema.parse({ browserLocalBrowser }).browserLocalBrowser).toBe(browserLocalBrowser)
	})

	it.each(["firefox", "Chrome", "", true, 1, null])("rejects invalid value %s", (browserLocalBrowser) => {
		expect(globalSettingsSchema.safeParse({ browserLocalBrowser }).success).toBe(false)
	})
})
