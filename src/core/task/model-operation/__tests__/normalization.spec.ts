import { Buffer } from "node:buffer"

import type { ApiMessage } from "../../../task-persistence/apiMessages"
import { assertContextFits, normalizeSnapshotMessages } from "../normalization"

const text = (value = "hello") => ({ type: "text" as const, text: value })
const call = (id = "call-1", input: unknown = {}) => ({ type: "tool_use", id, name: "read_file", input })
const result = (id = "call-1", content: unknown = "done") => ({ type: "tool_result", tool_use_id: id, content })
const assistant = (...content: unknown[]) => ({ role: "assistant", content })
const user = (...content: unknown[]) => ({ role: "user", content })
const pair = (input: unknown = {}) => [assistant(call("call-1", input)), user(result())]

describe("normalizeSnapshotMessages", () => {
	it("accepts readonly ApiMessage history and returns only detached canonical fields", () => {
		const messages: readonly ApiMessage[] = [
			{ role: "user", content: "hello", ts: 123, id: "response-1", isSummary: true },
			{ role: "assistant", content: [text("answer")], reasoning_content: "private", condenseId: "old" },
		]
		const normalized: ApiMessage[] = normalizeSnapshotMessages(messages)
		expect(normalized).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [text("answer")] },
		])
		expect(normalized).not.toBe(messages)
		expect(normalized[0]).not.toBe(messages[0])
		expect(normalized[1].content).not.toBe(messages[1].content)
		expect(normalized[1].content[0]).not.toBe(messages[1].content[0])
		expect(messages[0].id).toBe("response-1")
	})

	it("strips all provider metadata while retaining complete parallel calls and result order", () => {
		const extras = {
			id: "response-1",
			response_id: "response-2",
			signature: "opaque",
			thoughtSignature: "opaque",
			reasoning_content: "private",
			reasoning_details: [{ type: "reasoning.encrypted", data: "opaque" }],
			encrypted_content: "opaque",
			provider: "any-provider",
			cache_control: { type: "ephemeral" },
			citations: [{ provider: "extra" }],
			unknown_future_field: "extra",
		}
		const messages = [
			{
				...extras,
				...assistant(
					{ ...extras, ...text() },
					{ ...extras, ...call("a", { signature: "legitimate tool argument" }) },
					{ ...extras, ...call("b") },
				),
			},
			{
				...extras,
				...user(
					{ ...extras, ...result("b", [{ ...extras, ...text("failed") }]), is_error: true },
					{ ...extras, ...result("a"), is_error: false },
				),
			},
		]
		expect(normalizeSnapshotMessages(messages)).toEqual([
			assistant(text(), call("a", { signature: "legitimate tool argument" }), call("b")),
			user({ ...result("b", [text("failed")]), is_error: true }, { ...result("a"), is_error: false }),
		])
	})

	it("deeply copies frozen JSON, repeated references, null-prototype objects, and text results", () => {
		const nested = Object.freeze({ value: Object.freeze([null, true, false, 42, "text"]) })
		const input = Object.freeze(Object.assign(Object.create(null), { first: nested, second: nested }))
		const messages = Object.freeze([
			Object.freeze(assistant(Object.freeze(call("call-1", input)))),
			Object.freeze(user(Object.freeze(result("call-1", Object.freeze([Object.freeze(text())]))))),
		])
		const output = normalizeSnapshotMessages(messages)
		const blocks = output[0].content
		if (typeof blocks === "string" || blocks[0].type !== "tool_use") throw new Error("Expected tool use")
		const copied = blocks[0].input as { first: { value: unknown[] }; second: { value: unknown[] } }
		expect(copied).toEqual(input)
		expect(copied).not.toBe(input)
		expect(copied.first).not.toBe(nested)
		expect(copied.first).not.toBe(copied.second)
		copied.first.value.push("changed")
		expect(nested.value).toEqual([null, true, false, 42, "text"])
		const results = output[1].content
		if (typeof results === "string" || results[0].type !== "tool_result") throw new Error("Expected tool result")
		const content = results[0].content
		if (!Array.isArray(content) || content[0].type !== "text") throw new Error("Expected text")
		content[0].text = "changed"
		expect(messages[1].content).toEqual([result("call-1", [text()])])
	})

	it("drops only recognized opaque reasoning blocks and omits reasoning-only messages", () => {
		const reasoning = [
			{ type: "thinking", thinking: "private", signature: "opaque" },
			{ type: "redacted_thinking", data: "opaque" },
			{ type: "reasoning", encrypted_content: "opaque" },
		]
		expect(normalizeSnapshotMessages([assistant(...reasoning), assistant(...reasoning, text())])).toEqual([
			assistant(text()),
		])
		expect(normalizeSnapshotMessages([assistant(...reasoning, call()), user(...reasoning, result())])).toEqual(
			pair(),
		)
	})

	it("preserves empty content and optional empty result content without fabricating text", () => {
		expect(normalizeSnapshotMessages([])).toEqual([])
		expect(normalizeSnapshotMessages([{ role: "user", content: "" }, assistant()])).toEqual([
			{ role: "user", content: "" },
			assistant(),
		])
		for (const block of [
			result("call-1", ""),
			result("call-1", []),
			{ type: "tool_result", tool_use_id: "call-1" },
		]) {
			expect(normalizeSnapshotMessages([assistant(call()), user(block)])).toEqual([
				assistant(call()),
				user(block),
			])
		}
	})

	it.each([
		"image",
		"audio",
		"input_audio",
		"video",
		"document",
		"file",
		"tool_reference",
		"server_tool_use",
		"future",
	])("rejects unsupported %s blocks instead of flattening or dropping them", (type) => {
		const block = { type, text: "not a plain text block", source: { data: "opaque" } }
		expect(() => normalizeSnapshotMessages([user(text(), block)])).toThrow("unsupported content block")
		expect(() => normalizeSnapshotMessages([assistant(call()), user(result("call-1", [text(), block]))])).toThrow(
			"only plain text blocks",
		)
	})

	it.each(["thinking", "redacted_thinking", "reasoning"])("does not drop %s inside tool results", (type) => {
		expect(() => normalizeSnapshotMessages([assistant(call()), user(result("call-1", [{ type }]))])).toThrow()
	})

	it.each([
		["orphan result", [user(result())]],
		["incomplete call", [assistant(call())]],
		["wrong call role", [user(call()), user(result())]],
		["wrong result role", [assistant(call()), assistant(result())]],
		["intervening assistant", [assistant(call()), assistant(text()), user(result())]],
		["intervening user", [assistant(call()), user(text()), user(result())]],
		["intervening reasoning-only message", [assistant(call()), user({ type: "thinking" }), user(result())]],
		["missing parallel result", [assistant(call("a"), call("b")), user(result("a"))]],
		["split parallel batch", [assistant(call("a"), call("b")), user(result("a")), user(result("b"))]],
		["wrong batch", [assistant(call("a")), user(result("b"))]],
		["duplicate result", [assistant(call()), user(result(), result())]],
		["duplicate call in batch", [assistant(call(), call()), user(result())]],
		["globally reused call", [...pair(), ...pair()]],
		["repeated old result", [...pair(), assistant(call("b")), user(result())]],
	])("rejects %s", (_label, messages) => {
		expect(() => normalizeSnapshotMessages(messages as readonly unknown[])).toThrow()
	})

	it("accepts multiple complete independent batches", () => {
		const messages = [...pair(), assistant(text()), user(text()), assistant(call("b")), user(result("b"))]
		expect(normalizeSnapshotMessages(messages)).toEqual(messages)
	})

	it("preserves realistic complete batches, mixed text, nested inputs, and error results losslessly", () => {
		const canonical = [
			user(text("Inspect the files, then run the focused test.")),
			assistant(
				text("I will read both files."),
				call("toolu_read_source", { path: "src/main.ts", lines: { start: 1, end: 80 } }),
				call("call_read_test", { path: "src/main.spec.ts", options: [true, null, "全文"] }),
			),
			user(
				{ ...result("call_read_test", [text("ENOENT"), text("Test file not found")]), is_error: true },
				text("Continue using the existing source."),
				{ ...result("toolu_read_source", "export const value = 42\n"), is_error: false },
			),
			assistant(text("Checking the source."), {
				...call("call_run_test", { command: "npx vitest run main.spec.ts", cwd: "src" }),
				name: "execute_command",
			}),
			user(
				result("call_run_test", [text("No test files found"), text("Exit code: 1")]),
				text("Report the result."),
			),
		]
		const source = canonical.map((message) => ({
			...message,
			reasoning_details: [{ type: "reasoning.encrypted", data: "source-only" }],
			response_id: "source-response",
		}))
		const before = structuredClone(source)
		const normalized = normalizeSnapshotMessages(source)
		expect(normalized).toEqual(canonical)
		expect(normalizeSnapshotMessages(normalized)).toEqual(canonical)
		expect(source).toEqual(before)
	})

	it.each([
		["orphan after a complete batch", [user(result("orphan"))], "orphan, duplicate, or wrong-batch"],
		["unfinished next batch", [assistant(call("next-a"), call("next-b"))], "incomplete tool batch"],
		[
			"partially completed next batch",
			[assistant(call("next-a"), call("next-b")), user(result("next-a"), text("Continue"))],
			"complete the entire tool batch",
		],
		[
			"duplicate result in an otherwise complete batch",
			[assistant(call("next-a"), call("next-b")), user(result("next-b"), result("next-a"), result("next-b"))],
			"orphan, duplicate, or wrong-batch",
		],
		[
			"old call ID reused in a later parallel batch",
			[assistant(call("next-a"), call("call-1")), user(result("next-a"), result())],
			"globally unique",
		],
	] as const)("rejects %s without returning a valid prefix or mutating history", (_label, suffix, error) => {
		const history = [...pair({ path: "src/main.ts" }), ...suffix]
		const before = structuredClone(history)
		expect(() => normalizeSnapshotMessages(history)).toThrow(error)
		expect(history).toEqual(before)
	})

	it.each(
		[
			null,
			{},
			"history",
			[null],
			[[]],
			[{ role: "system", content: "text" }],
			[{ role: "user" }],
			[{ role: "assistant", content: null }],
			[user("text")],
			[user({ type: "text", text: 1 })],
			[user({ text: "missing type" })],
			[user({ type: "TEXT", text: "case sensitive" })],
			[assistant({ ...call(), id: " " }), user(result())],
			[assistant({ ...call(), name: "" }), user(result())],
			[assistant({ ...call(), id: 1 }), user(result())],
			[assistant(call()), user({ ...result(), tool_use_id: "" })],
			[assistant(call()), user({ ...result(), is_error: "false" })],
			[assistant(call()), user({ ...result(), is_error: undefined })],
			[assistant(call()), user(result("call-1", null))],
			[assistant(call()), user({ ...result(), content: undefined })],
		].map((messages) => ({ messages })),
	)("rejects malformed runtime input %#", ({ messages }) => {
		expect(() => normalizeSnapshotMessages(messages as readonly unknown[])).toThrow()
	})

	it.each([null, [], "input", 1, true, undefined].map((input) => ({ input })))(
		"requires object tool input %#",
		({ input }) => {
			expect(() => normalizeSnapshotMessages([assistant({ ...call(), input }), user(result())])).toThrow()
		},
	)

	it.each([undefined, NaN, Infinity, -Infinity, 1n, Symbol("input"), () => 1, new Date(), new Map(), /pattern/])(
		"rejects unsafe nested JSON value %#",
		(value) => {
			expect(() => normalizeSnapshotMessages(pair({ nested: [value] }))).toThrow()
		},
	)

	it("rejects cycles and excessive depth without modifying the original", () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => normalizeSnapshotMessages(pair(cyclic))).toThrow("cycles")
		expect(cyclic.self).toBe(cyclic)
		let deep: unknown = {}
		for (let i = 0; i < 102; i++) deep = { nested: deep }
		expect(() => normalizeSnapshotMessages(pair(deep))).toThrow("nesting limit")
	})

	it.each(["__proto__", "constructor", "prototype"])("rejects unsafe JSON key %s", (key) => {
		const input = JSON.parse(`{"${key}": {"polluted": true}}`)
		expect(() => normalizeSnapshotMessages(pair(input))).toThrow("unsafe object key")
		expect(Object.hasOwn(input, key)).toBe(true)
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
	})

	it("rejects symbols, hidden properties, class instances, sparse and decorated arrays", () => {
		class Input {
			value = "data"
		}
		const invalid = [
			{ [Symbol("hidden")]: 1 },
			Object.defineProperty({}, "hidden", { value: 1 }),
			new Input(),
			{ values: new Array(1) },
			{ values: Object.assign([1], { extra: "data" }) },
			{ values: Object.assign([1], { [Symbol("extra")]: true }) },
		]
		for (const input of invalid) expect(() => normalizeSnapshotMessages(pair(input))).toThrow()
		expect(() => normalizeSnapshotMessages(new Array(1))).toThrow()
		expect(() => normalizeSnapshotMessages([{ role: "user", content: new Array(1) }])).toThrow()
	})

	it("does not invoke getters or toJSON hooks and ignores opaque metadata getters", () => {
		const getter = vi.fn(() => "private")
		const withGetter = Object.defineProperty({}, "value", { get: getter, enumerable: true })
		expect(() => normalizeSnapshotMessages(pair(withGetter))).toThrow()
		const message = Object.defineProperty(user(text()), "role", { get: getter, enumerable: true })
		expect(() => normalizeSnapshotMessages([message])).toThrow()
		const content = Object.defineProperty([text()], "0", { get: getter, enumerable: true })
		expect(() => normalizeSnapshotMessages([{ role: "user", content }])).toThrow()
		const metadata = Object.defineProperty(user(text()), "signature", { get: getter, enumerable: true })
		expect(normalizeSnapshotMessages([metadata])).toEqual([user(text())])
		const toJSON = vi.fn(() => ({}))
		expect(() => normalizeSnapshotMessages(pair({ toJSON }))).toThrow()
		expect(getter).not.toHaveBeenCalled()
		expect(toJSON).not.toHaveBeenCalled()
	})
})

describe("assertContextFits", () => {
	const model = { contextWindow: 100_000, maxTokens: 1024 }

	it("returns an exact conservative UTF-8 budget including tools, nested blocks and output", () => {
		const messages = [assistant(call()), user(result("call-1", [text("世界")]))]
		const systemPrompt = "System\n世界"
		const toolsSerializedBytes = Buffer.byteLength('[{"name":"read_file"}]', "utf8")
		const inputBytes =
			Buffer.byteLength(JSON.stringify(messages), "utf8") +
			Buffer.byteLength(JSON.stringify(systemPrompt), "utf8") +
			toolsSerializedBytes
		const structuralOverhead = 1024 + 2 * 64 + 3 * 32 + 256
		expect(assertContextFits(messages, systemPrompt, model, toolsSerializedBytes)).toEqual({
			inputBytes,
			structuralOverhead,
			outputReserve: 1024,
			requiredContext: inputBytes + structuralOverhead + 1024,
			contextWindow: 100_000,
		})
	})

	it("defaults tool size to zero, permits exact fit, and rejects one unit over", () => {
		const report = assertContextFits([], "", model)
		expect(report.inputBytes).toBe(4)
		expect(report.structuralOverhead).toBe(1024)
		expect(assertContextFits([], "", { ...model, contextWindow: report.requiredContext })).toEqual({
			...report,
			contextWindow: report.requiredContext,
		})
		expect(() => assertContextFits([], "", { ...model, contextWindow: report.requiredContext - 1 })).toThrow(
			"context budget",
		)
	})

	it("counts UTF-8 bytes rather than characters or bytes divided by four", () => {
		const ascii = assertContextFits([], "aaaa", model)
		const unicode = assertContextFits([], "世界世界", model)
		expect(unicode.inputBytes - ascii.inputBytes).toBe(8)
		expect(() =>
			assertContextFits([{ role: "user", content: "a".repeat(4000) }], "", { contextWindow: 3000, maxTokens: 1 }),
		).toThrow()
	})

	it("includes JSON escaping, system prompt, tool size, and output reserve", () => {
		const base = assertContextFits([], "", model)
		expect(assertContextFits([], "\n", model).inputBytes - base.inputBytes).toBe(2)
		expect(assertContextFits([], "", model, 100).requiredContext - base.requiredContext).toBe(356)
		expect(assertContextFits([], "", { ...model, maxTokens: 2048 }).requiredContext - base.requiredContext).toBe(
			1024,
		)
		for (const invoke of [
			() => assertContextFits([], "a".repeat(100_000), model),
			() => assertContextFits([], "", model, 100_000),
			() => assertContextFits([], "", { ...model, maxTokens: 100_000 }),
		])
			expect(invoke).toThrow("context budget")
	})

	it.each([undefined, null, NaN, Infinity, -Infinity, 0, -1, 1.5, "10000", Number.MAX_SAFE_INTEGER + 1])(
		"fails closed for invalid or unknown context/output limit %#",
		(value) => {
			expect(() => assertContextFits([], "", { ...model, contextWindow: value as number })).toThrow()
			expect(() => assertContextFits([], "", { ...model, maxTokens: value as number })).toThrow()
		},
	)

	it.each([null, NaN, Infinity, -Infinity, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid serialized tool size %#",
		(value) => {
			expect(() => assertContextFits([], "", model, value as number)).toThrow("toolsSerializedBytes")
		},
	)

	it("rejects unsafe aggregate arithmetic, missing limits, and invalid prompt/model values", () => {
		expect(() => assertContextFits([], "", { contextWindow: 100_000 })).toThrow("maxTokens")
		expect(() =>
			assertContextFits([], "", { contextWindow: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER }),
		).toThrow()
		expect(() =>
			assertContextFits([], "", { ...model, contextWindow: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER),
		).toThrow()
		expect(() => assertContextFits([], null as unknown as string, model)).toThrow()
		expect(() => assertContextFits([], "", null as unknown as typeof model)).toThrow()
	})

	it("validates and budgets canonical content without counting stripped metadata or mutating inputs", () => {
		const messages = [Object.freeze({ ...user(text()), reasoning_content: "private".repeat(100_000) })]
		expect(assertContextFits(messages, "", model)).toEqual(assertContextFits([user(text())], "", model))
		expect(messages[0].reasoning_content.length).toBe(700_000)
		expect(() => assertContextFits([user({ type: "image" })], "", model)).toThrow()
		expect(() => assertContextFits([assistant(call())], "", model)).toThrow()
	})
})
