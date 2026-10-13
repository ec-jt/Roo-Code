import {
	prepareContextRecovery,
	readContextRecoverySnapshot,
	saveContextRecoverySnapshot,
	type ContextRecoverySnapshot,
} from "../context-recovery"
import { saveTaskSnapshot } from "../../task-persistence/taskSaves"
import * as fs from "fs/promises"

vi.mock("../../task-persistence/taskSaves", () => ({ saveTaskSnapshot: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: vi.fn(async () => "/storage") }))
vi.mock("fs/promises", () => ({ readFile: vi.fn() }))

const snapshot = (): ContextRecoverySnapshot => ({
	version: 1,
	taskId: "source",
	eventId: "event-1",
	apiMessages: [
		{ role: "user", content: "task" },
		{
			role: "assistant",
			id: "provider-response",
			content: [{ type: "tool_use", id: "child", name: "new_task", input: {} }],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "child", content: "Completed child summary" }] },
	],
	clineMessages: [
		{ ts: 1, type: "say", say: "text", text: "task" },
		{ ts: 2, type: "say", say: "text", text: "Completed child summary", checkpoint: { hash: "source" } },
		{ ts: 3, type: "say", say: "checkpoint_saved", text: "source-hash" },
	],
})

describe("context recovery snapshots", () => {
	beforeEach(() => vi.clearAllMocks())
	it("preserves the completed child exchange without mutating the source or copying checkpoint/response identities", () => {
		const source = snapshot()
		const before = structuredClone(source)
		const copy = prepareContextRecovery(source)
		expect(source).toEqual(before)
		expect(copy.apiMessages[2]).toEqual(source.apiMessages[2])
		expect(copy.apiMessages[1].id).toBeUndefined()
		expect(copy.clineMessages).toHaveLength(2)
		expect(copy.clineMessages[1].checkpoint).toBeUndefined()
	})
	it("keeps an earlier summary while restoring the selected event's exact input", () => {
		const source = snapshot()
		source.apiMessages[0] = { role: "user", content: "Earlier summary", isSummary: true, condenseId: "earlier" }
		expect(prepareContextRecovery(source).apiMessages[0]).toEqual(source.apiMessages[0])
	})
	it("rejects orphan results rather than silently dropping the child return", () => {
		const source = snapshot()
		source.apiMessages.splice(1, 1)
		expect(() => prepareContextRecovery(source)).toThrow("Unpaired recovery tool result")
	})
	it("rejects unfinished calls", () => {
		const source = snapshot()
		source.apiMessages.pop()
		expect(() => prepareContextRecovery(source)).toThrow("unfinished tool calls")
	})
	it("rejects duplicate calls", () => {
		const source = snapshot()
		source.apiMessages.push(structuredClone(source.apiMessages[1]))
		expect(() => prepareContextRecovery(source)).toThrow("Ambiguous recovery tool call")
	})
	it("saves through an exact task barrier", async () => {
		const source = snapshot()
		await saveContextRecoverySnapshot("/storage", source)
		expect(saveTaskSnapshot).toHaveBeenCalledWith(
			{ globalStoragePath: "/storage", taskId: "source", barrier: true },
			"context-recovery/event-1.json",
			expect.any(Function),
		)
	})
	it("refuses legacy events with no snapshot and invalid path identities", async () => {
		vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
		await expect(readContextRecoverySnapshot("/storage", "source", "event-1")).rejects.toThrow(
			"older context event",
		)
		await expect(readContextRecoverySnapshot("/storage", "source", "../escape")).rejects.toThrow(
			"Invalid context event",
		)
	})
	it("checks the stored source identity", async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(snapshot()))
		await expect(readContextRecoverySnapshot("/storage", "other", "event-1")).rejects.toThrow(
			"Invalid context recovery snapshot",
		)
	})
})
