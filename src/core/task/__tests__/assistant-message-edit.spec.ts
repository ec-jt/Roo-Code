import type { AssistantMessageEdit, ClineMessage } from "@roo-code/types"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	prepareAssistantMessageEdit,
	validateAssistantMessageEdit,
	assertNoInterruptedAssistantEdit,
} from "../assistant-message-edit"
import * as fs from "fs/promises"

vi.mock("fs/promises", async (original) => ({
	...(await original<typeof import("fs/promises")>()),
	stat: vi.fn(),
}))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: vi.fn().mockResolvedValue("/storage") }))

describe("interrupted assistant edit fence", () => {
	it("allows only an absent marker and fails closed on I/O errors", async () => {
		vi.mocked(fs.stat).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
		await expect(assertNoInterruptedAssistantEdit("/storage", "task")).resolves.toBeUndefined()
		vi.mocked(fs.stat).mockResolvedValueOnce({} as any)
		await expect(assertNoInterruptedAssistantEdit("/storage", "task")).rejects.toThrow("interrupted")
		vi.mocked(fs.stat).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
		await expect(assertNoInterruptedAssistantEdit("/storage", "task")).rejects.toThrow("denied")
	})
})

const edit: AssistantMessageEdit = {
	operationId: "edit",
	taskId: "task",
	instanceId: "instance",
	ts: 2,
	expectedText: "old",
	text: "new",
}
const histories = (): { ui: ClineMessage[]; api: ApiMessage[] } => ({
	ui: [
		{ ts: 1, type: "say", say: "text", text: "root" },
		{ ts: 2, type: "say", say: "text", text: "old", requestId: "r" },
		{ ts: 4, type: "say", say: "user_feedback", text: "later" },
	],
	api: [
		{ role: "user", content: "root" },
		{
			role: "assistant",
			ts: 3,
			requestId: "r",
			id: "response",
			reasoning_content: "reason",
			content: [
				{ type: "text", text: "old" },
				{ type: "tool_use", id: "tool", name: "read_file", input: { path: "file" } },
			],
		},
		{ role: "user", content: "later" },
		{ role: "assistant", id: "later-response", content: "later answer" },
	],
})

describe("assistant text mapping", () => {
	it("preserves later messages, tools and reasoning but invalidates response IDs", () => {
		const { ui, api } = histories()
		const result = prepareAssistantMessageEdit(ui, api, edit)
		expect(result.ui).toHaveLength(ui.length)
		expect(result.ui[2]).toBe(ui[2])
		expect(result.api[1]).toEqual({
			...api[1],
			id: undefined,
			content: [{ type: "text", text: "new" }, (api[1].content as any[])[1]],
		})
		expect(result.api[2]).toEqual(api[2])
		expect(result.api[3]).toEqual({ role: "assistant", content: "later answer" })
		expect(ui[1].text).toBe("old")
	})
	it.each([
		"duplicate",
		"transformed",
		"multiple blocks",
		"summary",
		"truncated",
		"before summary",
		"partial",
		"stale",
		"root",
	])("rejects %s mappings", (kind) => {
		const { ui, api } = histories()
		let payload = edit
		if (kind === "duplicate") api.push({ ...api[1] })
		if (kind === "transformed") api[1].content = "<thinking>reason</thinking>old"
		if (kind === "multiple blocks")
			api[1].content = [
				{ type: "text", text: "old" },
				{ type: "text", text: "old" },
			]
		if (kind === "summary") api[1].isSummary = true
		if (kind === "truncated") api[1].truncationParent = "truncation"
		if (kind === "before summary") api.push({ role: "assistant", isSummary: true, content: "summary" })
		if (kind === "partial") ui[1].partial = true
		if (kind === "stale") payload = { ...edit, expectedText: "different" }
		if (kind === "root") payload = { ...edit, ts: 1, expectedText: "root" }
		expect(() => prepareAssistantMessageEdit(ui, api, payload)).toThrow()
	})
	it("only supports unique timestamp-ordered legacy text", () => {
		const { ui, api } = histories()
		delete ui[1].requestId
		delete api[1].requestId
		expect(prepareAssistantMessageEdit(ui, api, edit).message.text).toBe("new")
		api[1].ts = 1
		expect(() => prepareAssistantMessageEdit(ui, api, edit)).toThrow("legacy")
	})
	it.each([
		undefined,
		{ ...edit, text: " " },
		{ ...edit, text: "x".repeat(1_000_001) },
		{ ...edit, ts: NaN },
		{ ...edit, taskId: 3 },
	])("validates runtime payloads", (payload) => {
		expect(() => validateAssistantMessageEdit(payload)).toThrow()
	})
})
