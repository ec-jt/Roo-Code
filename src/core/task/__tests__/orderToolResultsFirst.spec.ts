import { orderToolResultsFirst } from "../validateToolResultIds"

const result = (id: string) => ({ type: "tool_result" as const, tool_use_id: id, content: `result ${id}` })
const image = (n: number) => ({
	type: "image" as const,
	source: { type: "base64" as const, media_type: "image/png" as const, data: `img${n}` },
})
const text = (t: string) => ({ type: "text" as const, text: t })

describe("orderToolResultsFirst", () => {
	it("moves interleaved tool_results before images (parallel read_file on PNG files)", () => {
		// Shape that produced: "tool_use ids were found without tool_result blocks immediately after"
		const content = [result("a"), image(1), result("b"), image(2), result("c"), image(3), text("env")]

		const ordered = orderToolResultsFirst(content)

		expect(ordered.map((b) => b.type)).toEqual([
			"tool_result",
			"tool_result",
			"tool_result",
			"image",
			"image",
			"image",
			"text",
		])
		expect(ordered.slice(0, 3).map((b) => (b as ReturnType<typeof result>).tool_use_id)).toEqual(["a", "b", "c"])
		expect(ordered.slice(3, 6)).toEqual([image(1), image(2), image(3)])
	})

	it("returns the same array when tool_results already come first", () => {
		const content = [result("a"), result("b"), image(1), text("env")]
		expect(orderToolResultsFirst(content)).toBe(content)
	})

	it("returns the same array when there are no tool_results", () => {
		const content = [text("hello"), image(1)]
		expect(orderToolResultsFirst(content)).toBe(content)
	})

	it("moves a tool_result that follows a text block", () => {
		const content = [text("note"), result("a")]
		expect(orderToolResultsFirst(content).map((b) => b.type)).toEqual(["tool_result", "text"])
	})
})
