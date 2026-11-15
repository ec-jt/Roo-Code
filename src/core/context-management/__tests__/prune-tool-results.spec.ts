// cd src && npx vitest run core/context-management/__tests__/prune-tool-results.spec.ts

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { PRUNE_MARKER_PREFIX, pruneMarker, pruneToolResults } from "../prune-tool-results"

const opts = (overrides: Partial<Parameters<typeof pruneToolResults>[2]> = {}) => ({
	thresholdChars: 400,
	headChars: 100,
	tailChars: 50,
	save: vi.fn(async () => "tool-1.txt"),
	...overrides,
})

function toolResult(content: unknown, id = "t1"): ApiMessage {
	return { role: "user", content: [{ type: "tool_result", tool_use_id: id, content } as any] }
}

function call(id = "t1"): ApiMessage {
	return { role: "assistant", content: [{ type: "tool_use", id, name: "read_file", input: {} }] }
}

const resultText = (message: ApiMessage) => {
	const block = (message.content as any[])[0]
	return typeof block.content === "string" ? block.content : block.content
}

describe("pruneToolResults", () => {
	it("leaves results at the threshold unchanged and prunes one above it", async () => {
		const atLimit = "a".repeat(400)
		const over = "b".repeat(401)
		const messages = [call("x"), toolResult(atLimit, "x"), call("y"), toolResult(over, "y"), call("z")]
		const o = opts()
		const result = await pruneToolResults(messages, 4, o)
		expect(result.prunedCount).toBe(1)
		expect(result.messages[1]).toBe(messages[1])
		expect(o.save).toHaveBeenCalledWith(over)
		expect(resultText(result.messages[3])).toContain(PRUNE_MARKER_PREFIX)
	})

	it("keeps exact head and tail lengths", async () => {
		const text = "H".repeat(100) + "M".repeat(500) + "T".repeat(50)
		const result = await pruneToolResults([call(), toolResult(text), call("n")], 2, opts())
		const pruned = resultText(result.messages[1]) as string
		expect(pruned).toBe(`${"H".repeat(100)}\n\n${pruneMarker("tool-1.txt")}\n\n${"T".repeat(50)}`)
		expect(result.savedChars).toBe(text.length - pruned.length)
	})

	it("never splits surrogate pairs", async () => {
		const emoji = "\u{1F600}"
		const text = emoji.repeat(600)
		const result = await pruneToolResults([call(), toolResult(text), call("n")], 2, opts())
		const pruned = resultText(result.messages[1]) as string
		const [head, , tail] = pruned.split("\n\n")
		expect(Array.from(head)).toHaveLength(100)
		expect(Array.from(tail)).toHaveLength(50)
		expect(head).toBe(emoji.repeat(100))
		expect(tail).toBe(emoji.repeat(50))
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(pruned)).toBe(false)
	})

	it("keeps image and other blocks in order for array content", async () => {
		const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }
		const content = [
			{ type: "text", text: "x".repeat(300) },
			image,
			{ type: "text", text: "y".repeat(300) },
		]
		const result = await pruneToolResults([call(), toolResult(content), call("n")], 2, opts())
		const block = (result.messages[1].content as any[])[0]
		expect(block.tool_use_id).toBe("t1")
		expect(block.content).toHaveLength(2)
		expect(block.content[0].type).toBe("text")
		expect(block.content[0].text).toContain(PRUNE_MARKER_PREFIX)
		expect(block.content[1]).toBe(image)
	})

	it("keeps tool_use_id and is_error unchanged", async () => {
		const message: ApiMessage = {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "e1", is_error: true, content: "z".repeat(500) }],
		}
		const result = await pruneToolResults([call("e1"), message, call("n")], 2, opts())
		const block = (result.messages[1].content as any[])[0]
		expect(block.tool_use_id).toBe("e1")
		expect(block.is_error).toBe(true)
	})

	it("does not touch messages at or after preserveFrom", async () => {
		const messages = [call(), toolResult("q".repeat(500)), call("n"), toolResult("r".repeat(500), "n")]
		const result = await pruneToolResults(messages, 2, opts())
		expect(result.prunedCount).toBe(1)
		expect(result.messages[3]).toBe(messages[3])
	})

	it("is idempotent", async () => {
		const messages = [call(), toolResult("w".repeat(500)), call("n")]
		const o = opts()
		const first = await pruneToolResults(messages, 2, o)
		const second = await pruneToolResults(first.messages, 2, o)
		expect(second.prunedCount).toBe(0)
		expect(second.messages[1]).toBe(first.messages[1])
		expect(o.save).toHaveBeenCalledTimes(1)
	})

	it("leaves the block unchanged when save fails or returns undefined", async () => {
		const messages = [call(), toolResult("f".repeat(500)), call("n")]
		const undef = await pruneToolResults(messages, 2, opts({ save: vi.fn(async () => undefined) }))
		expect(undef.prunedCount).toBe(0)
		expect(undef.messages[1]).toBe(messages[1])
		const thrown = await pruneToolResults(
			messages,
			2,
			opts({
				save: vi.fn(async () => {
					throw new Error("disk full")
				}),
			}),
		)
		expect(thrown.prunedCount).toBe(0)
		expect(thrown.messages[1]).toBe(messages[1])
	})

	it("does not mutate the input", async () => {
		const messages = [call(), toolResult("m".repeat(500)), call("n")]
		const before = structuredClone(messages)
		await pruneToolResults(messages, 2, opts())
		expect(messages).toEqual(before)
	})

	it("rejects a budget where head + marker + tail exceed the threshold", async () => {
		await expect(pruneToolResults([], 0, opts({ thresholdChars: 200 }))).rejects.toThrow("Invalid pruning budget")
	})
})
