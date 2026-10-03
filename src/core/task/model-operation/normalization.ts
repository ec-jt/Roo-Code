import { Buffer } from "node:buffer"

import type { ApiMessage } from "../../task-persistence/apiMessages"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type TextBlock = { type: "text"; text: string }
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, JsonValue> }
type ToolResultBlock = {
	type: "tool_result"
	tool_use_id: string
	content?: string | TextBlock[]
	is_error?: boolean
}
type CanonicalBlock = TextBlock | ToolUseBlock | ToolResultBlock

function fail(reason: string): never {
	throw new Error(`Invalid snapshot: ${reason}`)
}

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object") {
		return fail("expected a plain object")
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		return fail("expected a plain object")
	}
	return value as Record<string, unknown>
}

// Never execute getters on canonical fields. Unknown metadata is not inspected.
function field(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key)
	if (!descriptor) {
		return undefined
	}
	if (!("value" in descriptor) || !descriptor.enumerable) {
		return fail("canonical fields must be enumerable data properties")
	}
	return descriptor.value
}

function array(value: unknown): unknown[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		return fail("expected a plain array")
	}
	// No holes, symbols, accessors, or custom array properties may be lost in copying.
	if (Reflect.ownKeys(value).length !== value.length + 1) {
		return fail("arrays must be dense and have no extra properties")
	}
	const result: unknown[] = []
	for (let index = 0; index < value.length; index++) {
		if (!Object.hasOwn(value, index)) {
			return fail("arrays must be dense")
		}
		result.push(field(value, String(index)))
	}
	return result
}

function string(value: unknown, nonempty = false): string {
	if (typeof value !== "string" || (nonempty && value.trim().length === 0)) {
		return fail("expected a string" + (nonempty ? " with non-whitespace content" : ""))
	}
	return value
}

function copyJson(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
	// A bounded depth also fails closed before recursion can exhaust the stack.
	if (depth > 100) {
		return fail("tool input exceeds the JSON nesting limit (100)")
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return value
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value
	}
	if (typeof value !== "object" || value === null) {
		return fail("tool input must contain only finite plain JSON values")
	}
	if (ancestors.has(value)) {
		return fail("tool input must not contain cycles")
	}
	ancestors.add(value)
	try {
		if (Array.isArray(value)) {
			return array(value).map((item) => copyJson(item, ancestors, depth + 1))
		}
		const source = record(value)
		const result: Record<string, JsonValue> = {}
		for (const key of Reflect.ownKeys(source)) {
			// Reject prototype-sensitive keys instead of silently changing their meaning.
			if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") {
				return fail("tool input contains an unsafe object key")
			}
			result[key] = copyJson(field(source, key), ancestors, depth + 1)
		}
		return result
	} finally {
		ancestors.delete(value)
	}
}

function textBlock(value: unknown): TextBlock {
	const source = record(value)
	if (field(source, "type") !== "text") {
		return fail("tool results support only plain text blocks")
	}
	return { type: "text", text: string(field(source, "text")) }
}

/**
 * Makes a detached, provider-neutral history without mutating the source.
 * Only role/content, text, tool id/name/input, and result id/content/is_error survive.
 * Recognized thinking/redacted_thinking/reasoning blocks are discarded; messages
 * containing only those blocks are omitted. Other unsupported content throws,
 * including non-text tool results. Adjacency is checked BEFORE omitting messages.
 * Empty strings/arrays and omitted result content remain empty, not fabricated.
 * Tool input must be a plain JSON object; unsafe keys, non-JSON values, accessors,
 * cycles, sparse/custom arrays and nesting deeper than 100 are rejected.
 * This is not a provider request adapter: it does not repair roles, reorder results,
 * rewrite IDs, or guarantee that a provider accepts an otherwise canonical history.
 * Inputs must be passive data, not hostile JavaScript proxies.
 */
export function normalizeSnapshotMessages(messages: readonly unknown[]): ApiMessage[] {
	const normalized: ApiMessage[] = []
	const usedIds = new Set<string>()
	let pending = new Set<string>()
	for (const value of array(messages)) {
		const source = record(value)
		const role = field(source, "role")
		if (role !== "assistant" && role !== "user") {
			return fail("message role must be assistant or user")
		}
		if (pending.size > 0 && role !== "user") {
			return fail("tool results must be in the immediately next user message")
		}
		const content = field(source, "content")
		const nextPending = new Set<string>()
		let canonical: string | CanonicalBlock[]
		let omittedReasoning = false
		if (typeof content === "string") {
			canonical = content
		} else {
			canonical = []
			for (const value of array(content)) {
				const block = record(value)
				const type = field(block, "type")
				switch (type) {
					case "thinking":
					case "redacted_thinking":
					case "reasoning":
						omittedReasoning = true
						break
					case "text":
						canonical.push(textBlock(block))
						break
					case "tool_use": {
						if (role !== "assistant") {
							return fail("tool_use requires the assistant role")
						}
						const id = string(field(block, "id"), true)
						if (usedIds.has(id)) {
							return fail("tool call IDs must be globally unique")
						}
						usedIds.add(id)
						nextPending.add(id)
						canonical.push({
							type,
							id,
							name: string(field(block, "name"), true),
							input: copyJson(record(field(block, "input"))) as Record<string, JsonValue>,
						})
						break
					}
					case "tool_result": {
						if (role !== "user") {
							return fail("tool_result requires the user role")
						}
						const id = string(field(block, "tool_use_id"), true)
						if (!pending.delete(id)) {
							return fail("orphan, duplicate, or wrong-batch tool result")
						}
						const result: ToolResultBlock = { type, tool_use_id: id }
						if (Object.hasOwn(block, "content")) {
							const resultContent = field(block, "content")
							result.content =
								typeof resultContent === "string" ? resultContent : array(resultContent).map(textBlock)
						}
						if (Object.hasOwn(block, "is_error")) {
							const isError = field(block, "is_error")
							if (typeof isError !== "boolean") {
								return fail("is_error must be a boolean")
							}
							result.is_error = isError
						}
						canonical.push(result)
						break
					}
					default:
						return fail("unsupported content block")
				}
			}
		}
		if (pending.size > 0) {
			return fail("the immediately next user message must complete the entire tool batch")
		}
		pending = nextPending
		if (!(omittedReasoning && Array.isArray(canonical) && canonical.length === 0)) {
			normalized.push({ role, content: canonical })
		}
	}
	if (pending.size > 0) {
		return fail("incomplete tool batch at end of history")
	}
	return normalized
}

/**
 * Validates the normalized snapshot with a deliberately conservative byte budget,
 * NOT a tokenizer or bytes/4 estimate. Returns the budget report, or throws.
 * inputBytes counts UTF-8 JSON bytes of normalized messages and systemPrompt,
 * plus toolsSerializedBytes (the caller must measure the complete serialized tools).
 * structuralOverhead = 1024 + 64/message + 32/block (including nested result text)
 * + 256 when tools are present. Each byte/overhead unit consumes one context unit.
 * requiredContext = inputBytes + structuralOverhead + maxTokens.
 * Limits must be positive safe integers; omitted maxTokens fails closed. Tool size
 * must be a nonnegative safe integer. No truncation or mutation is performed.
 * This can reject histories a tokenizer would accept and is not a universal bound
 * for arbitrary provider tokenizers/framing. Callers must budget any additional
 * request material themselves and still handle provider context-limit errors.
 */
export function assertContextFits(
	messages: readonly unknown[],
	systemPrompt: string,
	model: { contextWindow: number; maxTokens?: number },
	toolsSerializedBytes: number = 0,
): {
	inputBytes: number
	structuralOverhead: number
	outputReserve: number
	requiredContext: number
	contextWindow: number
} {
	const limits = record(model)
	const contextWindow = field(limits, "contextWindow")
	const maxTokens = field(limits, "maxTokens")
	if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
		throw new Error("Invalid contextWindow: a positive safe integer is required")
	}
	if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
		throw new Error("Invalid maxTokens: an explicit positive safe integer is required")
	}
	if (!Number.isSafeInteger(toolsSerializedBytes) || toolsSerializedBytes < 0) {
		throw new Error("Invalid toolsSerializedBytes: a nonnegative safe integer is required")
	}
	string(systemPrompt)
	const normalized = normalizeSnapshotMessages(messages)
	const inputBytes =
		Buffer.byteLength(JSON.stringify(normalized), "utf8") +
		Buffer.byteLength(JSON.stringify(systemPrompt), "utf8") +
		toolsSerializedBytes
	let blockCount = 0
	for (const message of normalized) {
		if (Array.isArray(message.content)) {
			blockCount += message.content.length
			for (const block of message.content) {
				if (block.type === "tool_result" && Array.isArray(block.content)) {
					blockCount += block.content.length
				}
			}
		}
	}
	const structuralOverhead = 1024 + normalized.length * 64 + blockCount * 32 + (toolsSerializedBytes > 0 ? 256 : 0)
	const requiredContext = inputBytes + structuralOverhead + maxTokens
	if (!Number.isSafeInteger(requiredContext) || requiredContext > contextWindow) {
		throw new Error("Snapshot exceeds the conservative context budget")
	}
	return { inputBytes, structuralOverhead, outputReserve: maxTokens, requiredContext, contextWindow }
}
