import { extensionForMediaType, offloadImages, OFFLOAD_MARKER_PREFIX } from "../offload-images"
import type { ApiMessage } from "../../task-persistence/apiMessages"

const img = (data: string, mediaType = "image/png") => ({
	type: "image" as const,
	source: { type: "base64" as const, media_type: mediaType as any, data },
})

function history(): ApiMessage[] {
	return [
		{ role: "user", content: [{ type: "text", text: "look" }, img("AAAA")] },
		{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser_action", input: {} }] },
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "shot" }, img("BBBB")] },
			],
		},
		{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		{ role: "user", content: [{ type: "text", text: "again" }, img("AAAA")] },
		{ role: "user", content: [img("CCCC")] },
	]
}

describe("offloadImages", () => {
	it("replaces only images before preserveFrom, in user content and tool results", async () => {
		const save = vi.fn(
			async (_data: string, mediaType: string, hash: string) =>
				`/t/images/${hash}.${extensionForMediaType(mediaType)}`,
		)
		const input = history()
		const { messages, offloadedCount } = await offloadImages(input, 5, save)
		expect(offloadedCount).toBe(3)
		const json = JSON.stringify(messages.slice(0, 5))
		expect(json).not.toContain('"type":"image"')
		expect(json).toContain(OFFLOAD_MARKER_PREFIX)
		expect(json).toContain("needs approval to read outside the workspace")
		// Recent message kept verbatim (same object).
		expect(messages[5]).toBe(input[5])
		// Input not mutated.
		expect(JSON.stringify(input)).toContain('"data":"AAAA"')
	})

	it("saves identical images once", async () => {
		const save = vi.fn(async (_d: string, _m: string, hash: string) => `/t/images/${hash}.png`)
		await offloadImages(history(), 5, save)
		expect(save).toHaveBeenCalledTimes(2)
		const hashes = save.mock.calls.map((call) => call[2])
		expect(new Set(hashes).size).toBe(2)
	})

	it("keeps the image when saving fails", async () => {
		const save = vi.fn(async () => {
			throw new Error("disk full")
		})
		const input = history()
		const { messages, offloadedCount } = await offloadImages(input, 5, save)
		expect(offloadedCount).toBe(0)
		expect(messages).toEqual(input)
		expect(messages[0]).toBe(input[0])
	})

	it("maps media types to file extensions", () => {
		expect(extensionForMediaType("image/jpeg")).toBe("jpg")
		expect(extensionForMediaType("image/png")).toBe("png")
		expect(extensionForMediaType("image/svg+xml")).toBe("svg")
		expect(extensionForMediaType("weird")).toBe("bin")
	})
})
