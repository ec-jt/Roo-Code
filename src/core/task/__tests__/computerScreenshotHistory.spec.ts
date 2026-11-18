import type { Anthropic } from "@anthropic-ai/sdk"

import { findComputerScreenshotMessages, KEEP_RECENT_COMPUTER_SCREENSHOTS } from "../computerScreenshotHistory"

const image: Anthropic.ImageBlockParam = {
	type: "image",
	source: { type: "base64", media_type: "image/png", data: "AA" },
}

function toolUse(name: string, id: string): Anthropic.MessageParam {
	return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] }
}

function result(id: string, withImage: boolean): Anthropic.MessageParam {
	return {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, content: "ok" }, ...(withImage ? [image] : [])],
	}
}

describe("findComputerScreenshotMessages", () => {
	it("returns only computer_action results that contain images, oldest first", () => {
		const history: Anthropic.MessageParam[] = [
			{ role: "user", content: [{ type: "text", text: "task" }, image] }, // pasted by the user
			toolUse("computer_action", "a"),
			result("a", true),
			toolUse("browser_action", "b"),
			result("b", true), // browser screenshot: not ours
			toolUse("computer_action", "c"),
			result("c", false), // list_windows: no image
			toolUse("computer_action", "d"),
			result("d", true),
		]

		const found = findComputerScreenshotMessages(history)

		expect(found).toEqual([history[2], history[8]])
	})

	it("keeps a small number of recent screenshots", () => {
		expect(KEEP_RECENT_COMPUTER_SCREENSHOTS).toBeGreaterThanOrEqual(2)
		expect(KEEP_RECENT_COMPUTER_SCREENSHOTS).toBeLessThanOrEqual(5)
	})
})
