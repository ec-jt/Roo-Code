import { browserControlJsonSchema } from "../../../core/prompts/tools/native-tools/browser-control-schema"

/**
 * Mirrors the strict-mode rewrite in OpenAiCodexHandler.buildRequestBody.
 * Kept local so the regression test does not require constructing the handler.
 */
const isObjectSchema = (schema: any) =>
	!!schema && typeof schema === "object" && (schema.type === "object" || !!schema.properties)

function ensureAllRequired(schema: any): any {
	if (!schema || typeof schema !== "object") return schema
	if (Array.isArray(schema)) return schema.map(ensureAllRequired)
	if (!isObjectSchema(schema)) {
		const result = { ...schema }
		if (result.items) result.items = ensureAllRequired(result.items)
		for (const key of ["anyOf", "oneOf", "allOf"] as const) {
			if (Array.isArray(result[key])) result[key] = result[key].map(ensureAllRequired)
		}
		if (result.$defs && typeof result.$defs === "object" && !Array.isArray(result.$defs)) {
			result.$defs = Object.fromEntries(
				Object.entries(result.$defs).map(([name, definition]) => [name, ensureAllRequired(definition)]),
			)
		}
		return result
	}
	const result = { ...schema }
	if (result.additionalProperties !== false) result.additionalProperties = false
	if (result.properties) {
		const allKeys = Object.keys(result.properties)
		result.required = allKeys
		const newProps = { ...result.properties }
		for (const key of allKeys) newProps[key] = ensureAllRequired(newProps[key])
		result.properties = newProps
	}
	for (const key of ["anyOf", "oneOf", "allOf"] as const) {
		if (Array.isArray(result[key])) result[key] = result[key].map(ensureAllRequired)
	}
	if (result.$defs && typeof result.$defs === "object" && !Array.isArray(result.$defs)) {
		result.$defs = Object.fromEntries(
			Object.entries(result.$defs).map(([name, definition]) => [name, ensureAllRequired(definition)]),
		)
	}
	return result
}

/** Every required name must exist in the same object's properties. */
function assertStrictConsistency(schema: any, path = "$"): void {
	if (!schema || typeof schema !== "object") return
	if (Array.isArray(schema)) {
		schema.forEach((item, index) => assertStrictConsistency(item, `${path}[${index}]`))
		return
	}
	if (schema.type === "object" && schema.properties) {
		for (const name of schema.required ?? []) {
			expect({ path, name, declared: name in schema.properties }).toEqual({ path, name, declared: true })
		}
	}
	for (const [key, value] of Object.entries(schema)) assertStrictConsistency(value, `${path}.${key}`)
}

describe("OpenAI Codex strict tool schema rewrite", () => {
	it("makes union branches strict without leaving undeclared required names", () => {
		const rewritten = ensureAllRequired(browserControlJsonSchema)
		assertStrictConsistency(rewritten)
		expect(rewritten.anyOf).toHaveLength(browserControlJsonSchema.anyOf.length)
		for (const branch of rewritten.anyOf) {
			expect(branch.additionalProperties).toBe(false)
			expect(branch.required).toEqual(expect.arrayContaining(Object.keys(branch.properties)))
		}
	})

	it("keeps the tabs branch valid after strict rewriting", () => {
		const rewritten = ensureAllRequired(browserControlJsonSchema)
		const tabs = rewritten.anyOf.find((branch: any) => branch.properties.action.enum[0] === "tabs")
		expect(tabs.required).toEqual(["action", "timeoutMs"])
		expect(tabs.properties).toHaveProperty("timeoutMs")
	})

	it("rewrites object schemas stored in $defs", () => {
		const schema = {
			type: "object",
			properties: { value: { $ref: "#/$defs/leaf" } },
			$defs: {
				leaf: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } } },
			},
		}
		const rewritten = ensureAllRequired(schema)
		expect(rewritten.$defs.leaf.required).toEqual(["first", "second"])
		expect(rewritten.$defs.leaf.additionalProperties).toBe(false)
	})
})
