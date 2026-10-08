import * as vscode from "vscode"
import type { Task } from "../../task/Task"
import { MemoryTool, boundedMemoryList, boundedMemoryRead } from "../MemoryTool"
import { getTaskMemoryStore } from "../../../services/memory/taskMemory"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { memoryArgsSchema } from "../../prompts/tools/native-tools/memory"
import type { MemoryRecord } from "../../../services/memory/types"

vi.mock("vscode", () => ({ workspace: { isTrusted: true }, window: { showWarningMessage: vi.fn() } }))
vi.mock("../../../services/memory/taskMemory", async (original) => ({
	...(await original<typeof import("../../../services/memory/taskMemory")>()),
	getTaskMemoryStore: vi.fn(),
}))

const id = "11111111-1111-4111-8111-111111111111"
const record: MemoryRecord = {
	id,
	name: "Topic",
	description: "Useful",
	type: "project",
	body: "Details",
	revision: "a".repeat(64),
	createdAt: "2026-01-01",
	modifiedAt: "2026-01-01",
}
const params = {
	action: "upsert",
	scope: "project",
	name: record.name,
	description: record.description,
	type: record.type,
	body: record.body,
	expected_revision: null,
} as const

describe("MemoryTool", () => {
	let task: Task
	let store: any
	let state: any
	let consent: any
	let callbacks: any
	const tool = new MemoryTool()
	beforeEach(() => {
		vi.clearAllMocks()
		Object.assign(vscode.workspace, { isTrusted: true })
		state = { mode: "code", customModes: [] }
		consent = { enabled: true, personalRecall: false, revision: "grant" }
		store = {
			getConsent: vi.fn(async () => ({ ...consent })),
			getDirectory: vi.fn(() => "/global/memory"),
			getRecordPath: vi.fn(() => `/global/memory/${id}.md`),
			read: vi.fn(async () => record),
			list: vi.fn(async () => ({ records: [record], errors: [], revision: "r", total: 1, omitted: 0 })),
			upsert: vi.fn(async (_scope, _input, options) => {
				await options.authorize()
				return record
			}),
			delete: vi.fn(async (_scope, _id, options) => options.authorize()),
		}
		vi.mocked(getTaskMemoryStore).mockResolvedValue(store)
		task = {
			taskId: "task",
			cwd: "/workspace",
			providerRef: { deref: () => ({ getState: async () => state, refreshMemoryBrowser: vi.fn() }) },
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		} as unknown as Task
		callbacks = { askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError: vi.fn() }
	})
	it("saves after ordinary approval and commit-time authorization", async () => {
		await tool.execute(params, task, callbacks)
		expect(store.upsert).toHaveBeenCalledWith(
			"project",
			expect.objectContaining({ sourceTaskId: "task" }),
			expect.objectContaining({ expectedRevision: null }),
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})
	it("does not mutate after denial", async () => {
		callbacks.askApproval.mockResolvedValue(false)
		await tool.execute(params, task, callbacks)
		expect(store.upsert).not.toHaveBeenCalled()
	})
	it("never opens the store while untrusted", async () => {
		Object.assign(vscode.workspace, { isTrusted: false })
		await tool.execute(params, task, callbacks)
		expect(getTaskMemoryStore).not.toHaveBeenCalled()
	})
	it("honors storage ignore policy", async () => {
		vi.mocked(task.rooIgnoreController!.validateAccess).mockReturnValue(false)
		await tool.execute(params, task, callbacks)
		expect(store.getConsent).not.toHaveBeenCalled()
		expect(store.upsert).not.toHaveBeenCalled()
	})
	it("rechecks consent in the store commit callback", async () => {
		store.upsert.mockImplementation(
			async (_scope: unknown, _input: unknown, options: { authorize: () => Promise<void> }) => {
				consent.enabled = false
				await options.authorize()
				return record
			},
		)
		await tool.execute(params, task, callbacks)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalled()
	})
	it.each(["disabled", "mode", "closed", "regrant"])("rechecks %s after approval", async (change) => {
		callbacks.askApproval.mockImplementation(async () => {
			if (change === "disabled") consent.enabled = false
			if (change === "mode") state.mode = "ask"
			if (change === "closed") task.abort = true
			if (change === "regrant") consent.revision = "new-grant"
			return true
		})
		await tool.execute(params, task, callbacks)
		expect(store.upsert).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalled()
	})
	it("rejects stale revisions before approval", async () => {
		await tool.execute({ ...params, id, expected_revision: "b".repeat(64) }, task, callbacks)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(store.upsert).not.toHaveBeenCalled()
	})
	it("does not read personal memory without recall consent", async () => {
		await tool.execute({ action: "read", scope: "personal", id, expected_revision: null }, task, callbacks)
		expect(store.read).not.toHaveBeenCalled()
	})
	it("requires exact native personal confirmation, not a model claim", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
		await tool.execute({ ...params, scope: "personal" }, task, callbacks)
		expect(store.upsert).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("across projects"),
			expect.objectContaining({ detail: expect.stringContaining('"personal"') }),
			"Save personal memory",
		)
	})
	it("withholds list results revoked during I/O", async () => {
		store.list.mockImplementation(async () => {
			consent.enabled = false
			return { records: [record], errors: [], total: 1 }
		})
		await tool.execute({ action: "list", scope: "project", expected_revision: null }, task, callbacks)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
	it("enforces output bounds and excludes bodies from lists", () => {
		const huge = { ...record, description: "x".repeat(512), body: "\u0001".repeat(32000) }
		const list = boundedMemoryList({
			records: Array(200).fill(huge),
			total: 200,
			omitted: 0,
			revision: "r",
			errors: Array(200).fill({ file: "bad", code: "bad", message: "bad" }),
		})
		expect(Buffer.byteLength(list)).toBeLessThanOrEqual(16 * 1024)
		expect(JSON.parse(list).records[0]).not.toHaveProperty("body")
		expect(JSON.parse(list)).toMatchObject({ truncated: true, errors: 200 })
		const read = boundedMemoryRead(huge)
		expect(Buffer.byteLength(read)).toBeLessThanOrEqual(32 * 1024)
		expect(JSON.parse(read).truncated).toBe(true)
	})
	it("validates in both parser and executor schema", () => {
		expect(memoryArgsSchema.safeParse({ ...params, path: "/etc/passwd" }).success).toBe(false)
		const valid = NativeToolCallParser.parseToolCall({
			id: "call",
			name: "memory",
			arguments: JSON.stringify(params),
		})
		expect(valid && "nativeArgs" in valid ? valid.nativeArgs : undefined).toEqual(params)
		const invalid = NativeToolCallParser.parseToolCall({
			id: "call",
			name: "memory",
			arguments: JSON.stringify({ ...params, path: "/etc/passwd" }),
		})
		expect(invalid && "nativeArgs" in invalid ? invalid.nativeArgs : undefined).toBeUndefined()
	})
})
