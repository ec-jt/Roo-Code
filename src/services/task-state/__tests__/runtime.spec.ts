import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import * as vscode from "vscode"
import type { Task } from "../../../core/task/Task"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { taskStatePolicySchema } from "../../../../packages/types/src/task-state"
import { taskHistoryAnchors, appendTaskStateRecall, taskStateRecall } from "../history"
import { taskStateTransaction, pinTaskStateRecall, assertTaskStateDispatch, syncTaskStateTodos } from "../taskState"
import {
	startTaskContinuation,
	stopTaskContinuation,
	reserveContinuationTurn,
	taskCompletionGate,
	resetTaskContinuation,
	attestTaskCheck,
	continuationView,
	assertContinuationToolAllowed,
} from "../continuation"
import { TaskStateTool } from "../../../core/tools/TaskStateTool"
import { handleTaskStateRequest } from "../../../core/webview/taskStateMessageHandler"
import { taskStateArgsSchema } from "../../../core/prompts/tools/native-tools/task_state"
import { checkAutoApproval } from "../../../core/auto-approval"

vi.mock("vscode", () => ({ workspace: { isTrusted: true }, window: { showWarningMessage: vi.fn() } }))
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (root: string, id: string) => path.join(root, id),
}))
let root: string
let task: Task
let provider: any
let usage: number
beforeEach(async () => {
	vi.clearAllMocks()
	Object.assign(vscode.workspace, { isTrusted: true })
	root = await fs.mkdtemp(path.join(os.tmpdir(), "roo-task-runtime-"))
	await fs.mkdir(path.join(root, "task"))
	usage = 0
	provider = {
		contextProxy: { globalStorageUri: { fsPath: root } },
		getCurrentTask: () => task,
		getState: async () => ({ mode: "code", customModes: [] }),
		postMessageToWebview: vi.fn(),
	}
	task = {
		taskId: "task",
		cwd: root,
		taskStateEpoch: 1,
		apiConfiguration: {},
		apiConversationHistory: [{ role: "user", content: "Build a feature" }],
		providerRef: { deref: () => provider },
		rooIgnoreController: { validateAccess: () => true },
		rooProtectedController: { isWriteProtected: () => false },
		getTokenUsage: () => ({ totalTokensIn: usage, totalTokensOut: 0 }),
		assertTaskStateNativeAllowed: vi.fn(),
	} as unknown as Task
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})
async function initialize() {
	const { store, options } = await taskStateTransaction(task, null)
	return store.initialize({
		...options,
		operations: [
			{ op: "set", field: "goal", value: "Build feature" },
			{ op: "set", field: "nextAction", value: "Implement" },
		],
	})
}
async function configure(overrides = {}) {
	const initialized = await initialize()
	const { store, options } = await taskStateTransaction(task, initialized.revision)
	await store.configurePolicy({
		...options,
		policy: taskStatePolicySchema.parse({
			enabled: true,
			checks: [{ id: "tests", text: "User confirms the focused regression test passes" }],
			...overrides,
		}),
	})
	await resetTaskContinuation(task)
}
describe("history coverage and pinned recall", () => {
	it("ignores tags and generated recalls but invalidates edited prefixes and selects rewind", async () => {
		const first = await initialize()
		const original = taskHistoryAnchors(task.apiConversationHistory)
		task.apiConversationHistory[0] = {
			...task.apiConversationHistory[0],
			condenseParent: "summary",
			truncationParent: "truncate",
		}
		task.apiConversationHistory.push(
			{ role: "user", content: "generated summary", isSummary: true },
			{ role: "user", content: [{ type: "text", text: taskStateRecall("recall") }] },
		)
		expect(taskHistoryAnchors(task.apiConversationHistory)).toEqual(original)
		task.apiConversationHistory.push({ role: "assistant", content: "Implemented" })
		const { store, options } = await taskStateTransaction(task, first.revision)
		const next = await store.patch({ ...options, operations: [{ op: "set", field: "nextAction", value: "Test" }] })
		task.apiConversationHistory.pop()
		expect(await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)).toMatchObject({
			revision: next.revision,
			snapshot: { revision: first.revision },
		})
		task.apiConversationHistory[0].content = "Edited request"
		expect((await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)).snapshot).toBeNull()
	})
	it("does nothing when absent, pins once, rejects revocation, and reinserts after compaction", async () => {
		expect(await pinTaskStateRecall(task)).toBe("")
		const initial = await initialize()
		const recall = await pinTaskStateRecall(task)
		expect(recall).toContain("lower-trust")
		const input = [{ type: "text" as const, text: "continue" }]
		const appended = appendTaskStateRecall(input, recall, [])
		expect(appended).toHaveLength(2)
		expect(appendTaskStateRecall(input, recall, [{ role: "user", content: appended }])).toEqual(input)
		expect(appendTaskStateRecall(input, recall, [{ role: "user", content: "summary" }])).toHaveLength(2)
		const { store, options } = await taskStateTransaction(task, initial.revision)
		await store.configurePolicy({ ...options, policy: taskStatePolicySchema.parse({ recallEnabled: false }) })
		await expect(assertTaskStateDispatch(task)).rejects.toMatchObject({ code: "STALE" })
	})
	it("keeps todo IDs and preserves manually changed ledger fields", async () => {
		await initialize()
		task.todoList = [{ id: "stable", content: "Implement", status: "completed" }]
		await syncTaskStateTodos(task, [])
		const { store } = await taskStateTransaction(task, null)
		let current = await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)
		expect(current.snapshot!.data.workItems[0]).toMatchObject({ id: "todo-stable", status: "implemented" })
		const { options } = await taskStateTransaction(task, current.revision)
		await store.correct({
			...options,
			operations: [
				{
					op: "upsert",
					collection: "workItems",
					value: { id: "todo-stable", text: "Manual correction", status: "blocked", evidenceIds: [] },
				},
			],
		})
		await syncTaskStateTodos(task, [{ id: "stable", content: "Implement", status: "completed" }])
		current = await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)
		expect(current.snapshot!.data.workItems[0].text).toBe("Manual correction")
	})
})
describe("model tool and native consent boundaries", () => {
	it("rejects model init/policy and stale or denied patches", async () => {
		expect(
			taskStateArgsSchema.safeParse({ action: "initialize", expected_revision: null, operations: null }).success,
		).toBe(false)
		const initial = await initialize()
		const tool = new TaskStateTool()
		const callbacks = { askApproval: vi.fn(async () => false), pushToolResult: vi.fn(), handleError: vi.fn() }
		const args = {
			action: "patch" as const,
			expected_revision: initial.revision,
			operations: JSON.stringify([{ op: "set", field: "goal", value: "Changed" }]),
		}
		await tool.execute(args, task, callbacks)
		const { store } = await taskStateTransaction(task, null)
		expect((await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)).revision).toBe(
			initial.revision,
		)
		callbacks.askApproval.mockClear()
		await tool.execute({ ...args, expected_revision: "a".repeat(64) }, task, callbacks)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})
	it.each(["ignore", "protected", "untrusted", "mode", "changed-task"])("denies %s access", async (kind) => {
		await initialize()
		if (kind === "ignore") task.rooIgnoreController!.validateAccess = () => false
		if (kind === "protected") task.rooProtectedController!.isWriteProtected = () => true
		if (kind === "untrusted") Object.assign(vscode.workspace, { isTrusted: false })
		if (kind === "mode") provider.getState = async () => ({ mode: "ask", customModes: [] })
		if (kind === "changed-task") provider.getCurrentTask = () => undefined
		const callbacks = { askApproval: vi.fn(async () => true), pushToolResult: vi.fn(), handleError: vi.fn() }
		await new TaskStateTool().execute(
			{ action: "read", expected_revision: null, operations: null },
			task,
			callbacks,
		)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})
	it("requires native confirmation and rejects a history change while reviewing", async () => {
		vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
			task.apiConversationHistory.push({ role: "assistant", content: "changed" })
			return "Approve task-state action" as any
		})
		await handleTaskStateRequest(provider, {
			requestId: "review",
			taskId: "task",
			action: "initialize",
			expectedRevision: null,
		})
		expect(provider.postMessageToWebview.mock.calls[0][0].taskStateResponse.error).toContain("changed")
		expect(await pinTaskStateRecall(task)).toBe("")
	})
	it("does not inherit all-actions approval", async () => {
		expect(
			await checkAutoApproval({
				state: { autoApprovalEnabled: true } as any,
				ask: "tool",
				text: JSON.stringify({ tool: "taskState", action: "patch" }),
			}),
		).toEqual({ decision: "ask" })
	})
})
describe("bounded continuation", () => {
	it("is default off and native start never resets a spent budget", async () => {
		await configure({ maxSteps: 1 })
		expect((await continuationView(task))!.armed).toBe(false)
		await startTaskContinuation(task)
		await reserveContinuationTurn(task)
		expect((await taskCompletionGate(task))?.continue).toBe(false)
		await expect(startTaskContinuation(task)).rejects.toThrow("step-limit")
		expect((await continuationView(task))!.steps).toBe(1)
	})
	it("continues pending criteria only while armed and stops on approval/cancellation", async () => {
		await configure()
		await startTaskContinuation(task)
		await reserveContinuationTurn(task)
		expect((await taskCompletionGate(task))?.continue).toBe(true)
		stopTaskContinuation(task, "awaiting-approval")
		await expect(reserveContinuationTurn(task)).rejects.toThrow("Native resume")
		expect((await taskCompletionGate(task))?.message).toContain("awaiting-approval")
	})
	it.each(["tokens", "model", "history", "no-progress"])("enforces %s bounds", async (kind) => {
		await configure({ maxTokens: 10, maxNoProgressSteps: 1 })
		await startTaskContinuation(task)
		await reserveContinuationTurn(task)
		if (kind === "tokens") usage = 11
		if (kind === "model") task.apiConfiguration = { apiProvider: "openai" }
		if (kind === "history") task.apiConversationHistory[0].content = "edited"
		await expect(
			kind === "no-progress" ? reserveContinuationTurn(task) : assertContinuationToolAllowed(task),
		).rejects.toThrow()
	})
	it("accepts only explicit user attestations and invalidates them after state changes", async () => {
		await configure()
		await attestTaskCheck(task, {
			id: "tests",
			result: "passed",
			note: "I ran the regression test and reviewed the result",
		})
		expect(await taskCompletionGate(task)).toMatchObject({ completed: true, continue: false })
		const { store } = await taskStateTransaction(task, null)
		const current = await store.read(taskHistoryAnchors(task.apiConversationHistory).anchors)
		const { options } = await taskStateTransaction(task, current.revision)
		await store.patch({ ...options, operations: [{ op: "set", field: "nextAction", value: "New work" }] })
		expect((await taskCompletionGate(task))?.completed).not.toBe(true)
	})
})
