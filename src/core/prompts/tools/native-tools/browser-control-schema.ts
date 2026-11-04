// This schema describes only implemented controls. Runtime validation remains strict and authoritative.
const id = { type: "string", minLength: 1, maxLength: 100 }
const timeoutMs = {
	type: "integer",
	minimum: 100,
	maximum: 15000,
	description: "Bounded operation timeout in milliseconds.",
}
const selected = { sessionId: id, tabId: id }
const reference = { ...selected, ref: { ...id, description: "Fresh opaque element reference returned by snapshot." } }
function command(action: string, fields: Record<string, unknown> = {}, optional: Record<string, unknown> = {}) {
	return {
		type: "object",
		additionalProperties: false,
		properties: { action: { type: "string", enum: [action] }, ...fields, ...optional },
		required: ["action", ...Object.keys(fields)],
	}
}
export const browserControlJsonSchema = {
	description:
		"Required for action=control. Typed CDP command, not raw CDP. Each command requires native user approval. Use status, then tabs and select_tab, or navigate to create an owned tab. Selected/ref commands require IDs from the latest result. Results enter task history and model context and may contain secrets. Unsupported evaluate, response_body, debugger and certificate exceptions are unavailable.",
	anyOf: [
		command("status"),
		command("tabs", {}, { timeoutMs }),
		command("select_tab", selected, { timeoutMs }),
		command(
			"navigate",
			{
				url: {
					type: "string",
					format: "uri",
					pattern: "^https?://",
					maxLength: 8192,
					description:
						"HTTP(S) URL. Navigates only the selected tab, or creates a Roo-owned tab if none is selected.",
				},
			},
			{ timeoutMs },
		),
		command("snapshot", selected, { timeoutMs, limit: { type: "integer", minimum: 1, maximum: 100 } }),
		command("click_ref", reference, { timeoutMs }),
		command("fill_ref", { ...reference, text: { type: "string", maxLength: 10000 } }, { timeoutMs }),
		command(
			"select_ref",
			{
				...reference,
				values: { type: "array", items: { type: "string", maxLength: 1000 }, minItems: 1, maxItems: 20 },
			},
			{ timeoutMs },
		),
		command("wait", { ...selected, durationMs: { type: "integer", minimum: 0, maximum: 5000 } }, { timeoutMs }),
		command("console", selected, {
			timeoutMs,
			clear: { type: "boolean", description: "Clear the bounded buffer after reading." },
		}),
		command("network", selected, {
			timeoutMs,
			clear: {
				type: "boolean",
				description: "Read metadata only, never response bodies. Clear the buffer after reading if true.",
			},
		}),
		command("inspect", reference, { timeoutMs }),
		command(
			"styles",
			{
				...reference,
				properties: {
					type: "array",
					items: { type: "string", pattern: "^[a-z-]{1,80}$" },
					minItems: 1,
					maxItems: 30,
				},
			},
			{ timeoutMs },
		),
		command("performance", selected, { timeoutMs }),
	],
}
