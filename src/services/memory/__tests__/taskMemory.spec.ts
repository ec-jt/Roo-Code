import * as vscode from "vscode"
import type { Task } from "../../../core/task/Task"
import { MemoryStore } from "../MemoryStore"
import { resolveMemoryProject } from "../project"
import {
	getTaskMemoryStore,
	getTaskMemoryContext,
	isTaskMemoryContext,
	assertTaskMemoryDispatch,
	appendTaskMemoryContext,
	needsTaskMemoryContext,
} from "../taskMemory"

vi.mock("vscode", () => ({ workspace: { isTrusted: true } }))
vi.mock("../project", () => ({ resolveMemoryProject: vi.fn() }))
vi.mock("../MemoryStore", () => ({ MemoryStore: vi.fn() }))

describe("task memory recall", () => {
	let task: Task
	let consent: { enabled: boolean; personalRecall: boolean; revision: string }
	let store: any
	beforeEach(() => {
		vi.clearAllMocks()
		Object.assign(vscode.workspace, { isTrusted: true })
		consent = { enabled: false, personalRecall: false, revision: "disabled" }
		store = {
			getConsent: vi.fn(async () => ({ ...consent })),
			getDirectory: vi.fn((scope) => `/global/memory/${scope}`),
			getRecallIndex: vi.fn(async () => ({
				text: "project:uuid topic\n",
				revision: "r",
				count: 1,
				omitted: 0,
				errors: [],
			})),
		}
		vi.mocked(MemoryStore).mockImplementation(() => store)
		vi.mocked(resolveMemoryProject).mockResolvedValue({
			key: "a".repeat(64),
			label: "project",
			rootPath: "/workspace",
		})
		task = {
			cwd: "/workspace",
			globalStoragePath: "/custom-task-history",
			say: vi.fn(),
			providerRef: { deref: () => ({ context: { globalStorageUri: { fsPath: "/global" } } }) },
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		} as unknown as Task
	})
	it("pins one store and uses extension global storage", async () => {
		const first = await getTaskMemoryStore(task)
		Object.assign(task, { cwd: "/other" })
		expect(await getTaskMemoryStore(task)).toBe(first)
		expect(resolveMemoryProject).toHaveBeenCalledTimes(1)
		expect(MemoryStore).toHaveBeenCalledWith("/global", expect.objectContaining({ rootPath: "/workspace" }))
	})
	it("does not access storage while untrusted", async () => {
		Object.assign(vscode.workspace, { isTrusted: false })
		expect(await getTaskMemoryContext(task)).toBe("")
		await expect(getTaskMemoryStore(task)).rejects.toMatchObject({ code: "UNTRUSTED" })
		expect(MemoryStore).not.toHaveBeenCalled()
	})
	it("defaults off without inventory or personal access", async () => {
		expect(await getTaskMemoryContext(task)).toBe("")
		expect(store.getRecallIndex).not.toHaveBeenCalled()
		expect(store.getDirectory).not.toHaveBeenCalled()
	})
	it("returns bounded recognizable metadata and never follows source references", async () => {
		consent = { enabled: true, personalRecall: false, revision: "yes" }
		const context = await getTaskMemoryContext(task)
		expect(isTaskMemoryContext(context)).toBe(true)
		expect(Buffer.byteLength(context)).toBeLessThanOrEqual(16 * 1024)
		expect(store.getRecallIndex).toHaveBeenCalledWith(15 * 1024)
		expect(store.getDirectory).not.toHaveBeenCalledWith("personal")
		expect(isTaskMemoryContext(`User mentions ${context}`)).toBe(false)
		expect(isTaskMemoryContext(context.replace("project:uuid", "edited:uuid"))).toBe(false)
	})
	it("fails closed if consent changes before dispatch, including disable/re-enable", async () => {
		consent = { enabled: true, personalRecall: false, revision: "yes" }
		await getTaskMemoryContext(task)
		await assertTaskMemoryDispatch(task)
		consent.revision = "new-grant"
		await expect(assertTaskMemoryDispatch(task)).rejects.toMatchObject({ code: "DISABLED" })
	})
	it("drops recall when consent changes during I/O", async () => {
		consent.enabled = true
		store.getRecallIndex.mockImplementation(async () => {
			consent.enabled = false
			return { text: "sensitive", errors: [], omitted: 0 }
		})
		expect(await getTaskMemoryContext(task)).toBe("")
	})
	it("preserves user content and provider cache prefixes, reloads after compaction", async () => {
		consent.enabled = true
		const context = await getTaskMemoryContext(task)
		const user = { type: "text" as const, text: "Please explain <roo_memory_context>" }
		const first = appendTaskMemoryContext([user], context, [])
		expect(first).toEqual([user, { type: "text", text: context }])
		const history = [{ role: "user" as const, content: first }]
		expect(appendTaskMemoryContext([user, { type: "text", text: context }], context, history)).toEqual([user])
		expect(history[0].content).toEqual(first)
		expect(needsTaskMemoryContext(context, [])).toBe(true)
		expect(appendTaskMemoryContext([user, { type: "text", text: context }], "", [])).toEqual([user])
	})
	it("refreshes a changed index even if an older revision reappears", async () => {
		consent.enabled = true
		const first = await getTaskMemoryContext(task)
		store.getRecallIndex.mockResolvedValue({
			text: "changed",
			revision: "changed",
			count: 1,
			omitted: 0,
			errors: [],
		})
		const second = await getTaskMemoryContext(task)
		const history = [
			{
				role: "user" as const,
				content: [
					{ type: "text" as const, text: first },
					{ type: "text" as const, text: second },
				],
			},
		]
		expect(needsTaskMemoryContext(first, history)).toBe(true)
		expect(needsTaskMemoryContext(second, history)).toBe(false)
	})
})
