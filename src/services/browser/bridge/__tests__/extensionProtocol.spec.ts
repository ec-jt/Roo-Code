// @ts-expect-error Plain MV3 JavaScript intentionally has no build/dependency pipeline.
import { commandMessage, pairing, safeUrl, nodeMetadata } from "../../../../../apps/browser-bridge/protocol.js"
import { randomUUID } from "node:crypto"

describe("Chrome companion protocol", () => {
	it("requires loopback endpoint and exact secret without arbitrary URL paths", () => {
		expect(
			pairing({ action: "pair", endpoint: "http://127.0.0.1:1234", secret: "a".repeat(64) }).endpoint,
		).toContain("127.0.0.1")
		for (const endpoint of [
			"http://localhost:1234",
			"http://private.test:1234",
			"http://127.0.0.1:1234/pair",
			"https://127.0.0.1:1234",
			"http://127.0.0.1:0",
		])
			expect(() => pairing({ action: "pair", endpoint, secret: "a".repeat(64) })).toThrow()
	})
	it("rejects raw protocol and unknown fields", () => {
		const message = {
			requestId: randomUUID(),
			documentId: randomUUID(),
			command: { action: "snapshot", sessionId: randomUUID(), tabId: randomUUID(), limit: 10 },
		}
		expect(commandMessage(message)).toEqual(message)
		for (const command of [
			{ method: "Runtime.evaluate" },
			{ ...message.command, approved: true },
			{ ...message.command, action: "click_ref" },
			{ ...message.command, limit: 101 },
		])
			expect(() => commandMessage({ ...message, command })).toThrow()
	})
	it("rejects unsupported pages and omits URL credentials/query/hash", () => {
		expect(safeUrl("https://user:password@example.test/path?secret=x#x")).toBe("https://example.test/path")
		for (const url of ["chrome://settings", "file:///tmp/test", "data:text/html,test", "about:blank"])
			expect(() => safeUrl(url)).toThrow()
	})
	it("exports bounded metadata, never input values or arbitrary attributes", () => {
		expect(
			nodeMetadata({
				localName: "input",
				attributes: ["value", "password", "onclick", "evil", "aria-label", "a".repeat(300), "type", "password"],
			}),
		).toEqual({ tag: "input", role: "", name: "a".repeat(256), type: "password" })
	})
})
