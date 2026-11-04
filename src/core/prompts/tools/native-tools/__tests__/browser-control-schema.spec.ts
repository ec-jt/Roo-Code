import { browserControlJsonSchema } from "../browser-control-schema"

interface ObjectSchema {
	type: string
	properties: Record<string, unknown>
	required: string[]
	additionalProperties?: boolean
}

describe("browser control native schema", () => {
	const variants = browserControlJsonSchema.anyOf as ObjectSchema[]

	it("declares every property and requires only non-optional fields", () => {
		expect(variants.length).toBeGreaterThan(0)
		for (const variant of variants) {
			expect(variant.type).toBe("object")
			expect(variant.additionalProperties).toBe(false)
			// Strict providers reject required entries that are not declared properties.
			for (const name of variant.required) expect(variant.properties).toHaveProperty(name)
			expect(variant.required).toContain("action")
			expect(new Set(variant.required).size).toBe(variant.required.length)
		}
	})

	it("keeps timeoutMs optional for every command that declares it", () => {
		const withTimeout = variants.filter((variant) => "timeoutMs" in variant.properties)
		expect(withTimeout.length).toBeGreaterThan(0)
		for (const variant of withTimeout) expect(variant.required).not.toContain("timeoutMs")
	})

	it("keeps snapshot limit and console/network clear optional", () => {
		for (const variant of variants) {
			const action = (variant.properties.action as { enum: string[] }).enum[0]
			if (action === "snapshot") expect(variant.required).not.toContain("limit")
			if (action === "console" || action === "network") expect(variant.required).not.toContain("clear")
		}
	})

	it("uses only strict-schema-safe keywords", () => {
		// Strict providers reject format:"uri" and similar annotation keywords.
		const unsupported = new Set(["format", "default", "examples", "patternProperties", "dependencies"])
		const walk = (node: unknown, path: string) => {
			if (!node || typeof node !== "object") return
			if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${path}[${index}]`))
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				expect({ path, key, unsupported: unsupported.has(key) }).toEqual({ path, key, unsupported: false })
				walk(value, `${path}.${key}`)
			}
		}
		walk(browserControlJsonSchema, "$")
	})
	it("requires the documented identifiers for selected and reference commands", () => {
		for (const variant of variants) {
			const action = (variant.properties.action as { enum: string[] }).enum[0]
			if (["select_tab", "snapshot", "wait", "console", "network", "performance"].includes(action)) {
				expect(variant.required).toEqual(expect.arrayContaining(["sessionId", "tabId"]))
			}
			if (["click_ref", "fill_ref", "select_ref", "inspect", "styles"].includes(action)) {
				expect(variant.required).toEqual(expect.arrayContaining(["sessionId", "tabId", "ref"]))
			}
		}
	})
})
