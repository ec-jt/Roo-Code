import * as vscode from "vscode"
import { Task } from "../Task"
import { taskStateTransaction } from "../../../services/task-state/taskState"
import { taskHistoryAnchors } from "../../../services/task-state/history"
import { getEffectiveApiHistory } from "../../condense"
import { saveContextRecoverySnapshot } from "../../context-management/context-recovery"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { taskStatePolicySchema } from "../../../../packages/types/src/task-state"

vi.mock("vscode", async (original) => {
	const actual = await original<typeof import("vscode")>()
	return { ...actual, window: { ...actual.window, showWarningMessage: vi.fn() } }
})
vi.mock("../../../services/task-state/taskState", () => ({ taskStateTransaction: vi.fn() }))
vi.mock("../../context-management/context-recovery", async (original) => ({
	...(await original<typeof import("../../context-management/context-recovery")>()),
	saveContextRecoverySnapshot: vi.fn(),
}))
vi.mock("../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn(async () => ({ tools: [] })) }))
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getTerminals: vi.fn(() => []) },
}))

describe("Task reviewed state context", () => {
	let task: any
	let state: any
	let store: any
	let order: string[]
	beforeEach(() => {
		vi.clearAllMocks()
		order = []
		task = Object.create(Task.prototype)
		Object.defineProperty(task, "cwd", { value: "/workspace" })
		Object.assign(task, {
			taskId: "task",
			globalStoragePath: "/storage",
			isInitialized: true,
			modelOperationRevision: 1,
			modelDispatchControllers: new Set(),
			modelOperationAdmission: { pending: false },
			diffViewProvider: { isEditing: false },
			userMessageContent: [],
			apiConversationHistory: [
				{ role: "user", content: "Goal" },
				{ role: "assistant", content: "Plan" },
				{ role: "user", content: "Next step" },
			],
			clineMessages: [{ ts: 1, type: "say", say: "text", text: "Goal" }],
			api: { getModel: () => ({ id: "test", info: { contextWindow: 100_000, maxTokens: 1000 } }) },
			getSystemPrompt: async () => "system",
			getTokenUsage: () => ({ contextTokens: 12 }),
			flushPersistence: vi.fn(),
			saveApiConversationHistory: vi.fn(async () => {
				order.push("history")
				return true
			}),
			say: vi.fn(),
		})
		task.providerRef = {
			deref: () => ({
				getCurrentTask: () => task,
				getState: async () => ({ mode: "code", apiConfiguration: {} }),
			}),
		}
		const history = taskHistoryAnchors(task.apiConversationHistory)
		state = {
			revision: "a".repeat(64),
			policy: taskStatePolicySchema.parse({}),
			snapshot: {
				revision: "a".repeat(64),
				historyAnchor: history.anchor,
				historyPosition: history.position,
				data: {
					goal: "Goal",
					nextAction: "Next step",
					acceptanceCriteria: [],
					constraints: [],
					decisions: [],
					workItems: [],
					evidenceRefs: [],
					failedApproaches: [],
					blockers: [],
				},
			},
		}
		store = { read: vi.fn(async () => state) }
		vi.mocked(taskStateTransaction).mockResolvedValue({
			store,
			options: {
				expectedRevision: state.revision,
				historyAnchor: history.anchor,
				historyPosition: history.position,
				validHistoryAnchors: history.anchors,
				authorize: async () => {},
			},
		} as any)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Create fresh context" as any)
		vi.mocked(saveContextRecoverySnapshot).mockImplementation(async () => {
			order.push("recovery")
		})
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
	})
	it("saves recovery first, retains original messages, and creates deterministic context without a model call", async () => {
		const original = structuredClone(task.apiConversationHistory)
		await task.createReviewedTaskStateContext(state.revision)
		expect(order).toEqual(["recovery", "history"])
		expect(
			task.apiConversationHistory
				.filter((message: any) => !message.isSummary)
				.map((message: any) => message.content),
		).toEqual(original.map((message: any) => message.content))
		expect(taskHistoryAnchors(task.apiConversationHistory)).toEqual(taskHistoryAnchors(original))
		expect(getEffectiveApiHistory(task.apiConversationHistory)).toHaveLength(2)
		expect(task.apiConversationHistory.find((message: any) => message.isSummary).content[0].text).toContain(
			"Earlier history is retained",
		)
		expect(task.skipPrevResponseIdOnce).toBe(true)
		expect(task.contextRecoveryActive).toBe(false)
	})
	it.each(["prepared", "pending-tools", "streaming", "terminal", "coverage", "budget", "cancel", "stale"])(
		"refuses %s before history persistence",
		async (kind) => {
			if (kind === "prepared") task.modelOperationPrepared = true
			if (kind === "pending-tools") task.userMessageContent = [{ type: "tool_result", tool_use_id: "missing" }]
			if (kind === "streaming") task.isStreaming = true
			if (kind === "terminal") vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([{}] as any)
			if (kind === "coverage") state.snapshot.historyPosition = 0
			if (kind === "budget")
				task.api.getModel = () => ({ id: "tiny", info: { contextWindow: 100, maxTokens: 90 } })
			if (kind === "cancel") vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
			if (kind === "stale")
				vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
					state.revision = "b".repeat(64)
					return "Create fresh context" as any
				})
			await expect(task.createReviewedTaskStateContext("a".repeat(64))).rejects.toThrow()
			expect(task.saveApiConversationHistory).not.toHaveBeenCalled()
			expect(saveContextRecoverySnapshot).not.toHaveBeenCalled()
		},
	)
	it("refuses incomplete persisted tool pairs", async () => {
		task.apiConversationHistory[1] = {
			role: "assistant",
			content: [{ type: "tool_use", id: "unfinished", name: "read_file", input: {} }],
		}
		await expect(task.createReviewedTaskStateContext(state.revision)).rejects.toThrow("unfinished")
		expect(saveContextRecoverySnapshot).not.toHaveBeenCalled()
	})
	it("refuses unsupported split-result batches without mutating history", async () => {
		task.apiConversationHistory = [
			{ role: "user", content: "Goal" },
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "a", name: "read_file", input: {} },
					{ type: "tool_use", id: "b", name: "read_file", input: {} },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A" }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "B" }] },
		]
		const original = structuredClone(task.apiConversationHistory)
		const history = taskHistoryAnchors(original)
		Object.assign(state.snapshot, { historyAnchor: history.anchor, historyPosition: history.position })
		vi.mocked(taskStateTransaction).mockResolvedValue({
			store,
			options: {
				expectedRevision: state.revision,
				historyAnchor: history.anchor,
				historyPosition: history.position,
				validHistoryAnchors: history.anchors,
				authorize: async () => {},
			},
		} as any)
		await expect(task.createReviewedTaskStateContext(state.revision)).rejects.toThrow("entire tool batch")
		expect(task.apiConversationHistory).toEqual(original)
		expect(task.saveApiConversationHistory).not.toHaveBeenCalled()
		expect(saveContextRecoverySnapshot).not.toHaveBeenCalled()
		expect(taskHistoryAnchors(task.apiConversationHistory)).toEqual(history)
	})
	it("retains consecutive newest user inputs", async () => {
		task.apiConversationHistory.push({ role: "user", content: "Do not deploy" })
		const original = structuredClone(task.apiConversationHistory)
		const history = taskHistoryAnchors(original)
		Object.assign(state.snapshot, { historyAnchor: history.anchor, historyPosition: history.position })
		vi.mocked(taskStateTransaction).mockResolvedValue({
			store,
			options: {
				expectedRevision: state.revision,
				historyAnchor: history.anchor,
				historyPosition: history.position,
				validHistoryAnchors: history.anchors,
				authorize: async () => {},
			},
		} as any)
		await task.createReviewedTaskStateContext(state.revision)
		expect(getEffectiveApiHistory(task.apiConversationHistory).slice(1)).toEqual(original.slice(-2))
		expect(taskHistoryAnchors(task.apiConversationHistory)).toEqual(history)
	})
	it.each([false, "throw"])("restores live history and closes dispatch on failed save (%s)", async (failure) => {
		const original = structuredClone(task.apiConversationHistory)
		task.saveApiConversationHistory.mockImplementation(async () => {
			if (failure === "throw") throw new Error("storage failure")
			return false
		})
		await expect(task.createReviewedTaskStateContext(state.revision)).rejects.toThrow("dispatch is closed")
		expect(task.apiConversationHistory).toEqual(original)
		expect(task.modelOperationDispatchClosed).toBe(true)
		expect(saveContextRecoverySnapshot).toHaveBeenCalledTimes(1)
		expect(task.say).not.toHaveBeenCalled()
	})
})
