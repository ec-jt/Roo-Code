// cd src && npx vitest run core/task/__tests__/Task.persistence.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@roo-code/types"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const {
	mockSaveApiMessages,
	mockSaveTaskMessages,
	mockReadApiMessages,
	mockReadTaskMessages,
	mockTaskMetadata,
	mockFlushTaskSaves,
	mockCheckpointSave,
	mockPWaitFor,
} = vi.hoisted(() => ({
	mockSaveApiMessages: vi.fn().mockResolvedValue(undefined),
	mockSaveTaskMessages: vi.fn().mockResolvedValue(undefined),
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
	mockFlushTaskSaves: vi.fn().mockResolvedValue(undefined),
	mockCheckpointSave: vi.fn().mockResolvedValue(undefined),
	mockTaskMetadata: vi.fn().mockResolvedValue({
		historyItem: { id: "test-id", ts: Date.now(), task: "test" },
		tokenUsage: {
			totalTokensIn: 0,
			totalTokensOut: 0,
			totalCacheWrites: 0,
			totalCacheReads: 0,
			totalCost: 0,
			contextTokens: 0,
		},
	}),
	mockPWaitFor: vi.fn().mockResolvedValue(undefined),
}))

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	return {
		...actual,
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockResolvedValue("[]"),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
		default: {
			mkdir: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn().mockResolvedValue(undefined),
			readFile: vi.fn().mockResolvedValue("[]"),
			unlink: vi.fn().mockResolvedValue(undefined),
			rmdir: vi.fn().mockResolvedValue(undefined),
		},
	}
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("../../task-persistence", () => ({
	flushTaskSaves: mockFlushTaskSaves,
	saveApiMessages: mockSaveApiMessages,
	saveTaskMessages: mockSaveTaskMessages,
	readApiMessages: mockReadApiMessages,
	readTaskMessages: mockReadTaskMessages,
	taskMetadata: mockTaskMetadata,
	TaskHistoryStore: vi.fn().mockImplementation(() => ({
		initialize: vi.fn().mockResolvedValue(undefined),
		dispose: vi.fn(),
		get: vi.fn(),
		getAll: vi.fn().mockReturnValue([]),
		upsert: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		deleteMany: vi.fn().mockResolvedValue(undefined),
		reconcile: vi.fn().mockResolvedValue(undefined),
		initialized: Promise.resolve(),
	})),
}))

vi.mock("../../checkpoints", () => ({
	checkpointSave: mockCheckpointSave,
	getCheckpointService: vi.fn(),
	checkpointRestore: vi.fn(),
	checkpointDiff: vi.fn(),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation(async (globalStoragePath) => globalStoragePath),
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockReturnValue(false),
}))

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("Task persistence", () => {
	let mockProvider: ClineProvider & Record<string, any>
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: vscode.OutputChannel
	let mockExtensionContext: vscode.ExtensionContext

	beforeEach(() => {
		vi.clearAllMocks()

		const storageUri = { fsPath: path.join(os.tmpdir(), "test-storage") }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as ClineProvider & Record<string, any>

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.updateTaskHistory = vi.fn().mockResolvedValue(undefined)
	})

	// ── saveApiConversationHistory (via retrySaveApiConversationHistory) ──

	describe("saveApiConversationHistory", () => {
		it("returns true on success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.apiConversationHistory.push({
				role: "user",
				content: [{ type: "text", text: "hello" }],
			})

			const result = await task.retrySaveApiConversationHistory()
			expect(result).toBe(true)
		})

		it("returns false on failure", async () => {
			vi.useFakeTimers()

			// All 3 retry attempts must fail for retrySaveApiConversationHistory to return false
			mockSaveApiMessages
				.mockRejectedValueOnce(new Error("fail 1"))
				.mockRejectedValueOnce(new Error("fail 2"))
				.mockRejectedValueOnce(new Error("fail 3"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(false)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(3)

			vi.useRealTimers()
		})

		it("succeeds on 2nd retry attempt", async () => {
			vi.useFakeTimers()

			mockSaveApiMessages.mockRejectedValueOnce(new Error("fail 1")).mockResolvedValueOnce(undefined) // succeeds on 2nd try

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const promise = task.retrySaveApiConversationHistory()
			await vi.runAllTimersAsync()
			const result = await promise

			expect(result).toBe(true)
			expect(mockSaveApiMessages).toHaveBeenCalledTimes(2)

			vi.useRealTimers()
		})

		it("passes the live array to the snapshotting persistence API with an exact retry barrier", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const originalMsg = {
				role: "user" as const,
				content: [{ type: "text" as const, text: "snapshot test" }],
			}
			task.apiConversationHistory.push(originalMsg)

			await task.retrySaveApiConversationHistory()

			expect(mockSaveApiMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveApiMessages.mock.calls[0][0]
			expect(callArgs.messages).toBe(task.apiConversationHistory)
			expect(callArgs.barrier).toBe(true)
			expect(mockFlushTaskSaves).toHaveBeenCalled()
		})
	})

	// ── saveClineMessages ────────────────────────────────────────────────

	describe("saveClineMessages", () => {
		it("returns true on success", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveClineMessages()
			expect(result).toBe(true)
		})

		it("returns false on failure", async () => {
			mockSaveTaskMessages.mockRejectedValueOnce(new Error("write error"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			const result = await (task as Record<string, any>).saveClineMessages()
			expect(result).toBe(false)
		})

		it("passes the live array to the snapshotting persistence API", async () => {
			mockSaveTaskMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			task.clineMessages.push({
				type: "say",
				say: "text",
				text: "snapshot test",
				ts: Date.now(),
			})

			await (task as Record<string, any>).saveClineMessages()

			expect(mockSaveTaskMessages).toHaveBeenCalledTimes(1)

			const callArgs = mockSaveTaskMessages.mock.calls[0][0]
			expect(callArgs.messages).toBe(task.clineMessages)
			expect(callArgs.barrier).toBe(false)
		})
	})

	describe("durability boundaries", () => {
		const createTask = () =>
			new Task({ provider: mockProvider, apiConfiguration: mockApiConfig, task: "test", startTask: false })

		it("strict UI saves use a barrier and reject failed flushes", async () => {
			const task = createTask()
			mockFlushTaskSaves.mockRejectedValueOnce(new Error("flush failed"))
			await expect((task as any).saveClineMessages(true)).rejects.toThrow("flush failed")
			expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ barrier: true }))
			expect(mockProvider.updateTaskHistory).not.toHaveBeenCalled()
		})

		it("overwrites fail closed and use exact snapshots", async () => {
			const task = createTask()
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk full"))
			await expect(task.overwriteApiConversationHistory([])).rejects.toThrow("Could not overwrite")
			expect(mockSaveApiMessages).toHaveBeenCalledWith(expect.objectContaining({ barrier: true }))
			mockSaveTaskMessages.mockRejectedValueOnce(new Error("disk full"))
			await expect(task.overwriteClineMessages([])).rejects.toThrow("disk full")
			expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ barrier: true }))
		})

		it("flushes admitted writes even with no pending delegation tool results", async () => {
			const task = createTask()
			mockFlushTaskSaves.mockRejectedValueOnce(new Error("flush failed"))
			await expect(task.flushPendingToolResultsToHistory()).resolves.toBe(false)
			expect(mockFlushTaskSaves).toHaveBeenCalledOnce()
		})

		it("does not turn a missing assistant boundary into a successful retry", async () => {
			const task = createTask()
			task.userMessageContent = [{ type: "tool_result", tool_use_id: "pending", content: "result" }]
			await expect(task.retrySaveApiConversationHistory()).resolves.toBe(false)
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
		})

		it("does not resume the parent loop after its exact history save fails", async () => {
			const task = createTask()
			mockProvider.getCurrentTask = vi.fn().mockReturnValue(task)
			vi.spyOn(task, "assertCanDelegate").mockResolvedValue(undefined)
			const loop = vi.spyOn(task as any, "initiateTaskLoop").mockResolvedValue(undefined)
			task.apiConversationHistory = [{ role: "user", content: [{ type: "text", text: "result" }] }]
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk full"))
			await expect(task.resumeAfterDelegation()).rejects.toThrow("Could not save parent history")
			expect(mockSaveApiMessages).toHaveBeenCalledWith(expect.objectContaining({ barrier: true }))
			expect(loop).not.toHaveBeenCalled()
		})

		it("waits for flush before reading saved history", async () => {
			const task = createTask()
			mockFlushTaskSaves.mockRejectedValueOnce(new Error("flush failed"))
			await expect((task as any).getSavedApiConversationHistory()).rejects.toThrow("flush failed")
			expect(mockReadApiMessages).not.toHaveBeenCalled()
		})

		it("gates checkpoints on persistence and fails closed", async () => {
			const task = createTask()
			let finish!: () => void
			mockFlushTaskSaves.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
			const saving = task.checkpointSave(true, true)
			expect(mockCheckpointSave).not.toHaveBeenCalled()
			finish()
			await saving
			expect(mockCheckpointSave).toHaveBeenCalledWith(task, true, true)
			mockCheckpointSave.mockClear()
			mockFlushTaskSaves.mockRejectedValueOnce(new Error("flush failed"))
			await expect(task.checkpointSave()).rejects.toThrow("flush failed")
			expect(mockCheckpointSave).not.toHaveBeenCalled()
		})

		it("captures indexed full-history metadata before a queued write completes", async () => {
			const task = createTask()
			task.clineMessages = [
				{ type: "say", say: "text", text: "task", ts: 1 },
				{ type: "say", say: "api_req_started", text: '{"tokensIn":42,"tokensOut":7,"cost":0.5}', ts: 2 },
				{ type: "say", say: "text", text: "done", ts: 3 },
			]
			let finish!: () => void
			mockSaveTaskMessages.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
			const saving = (task as any).saveClineMessages()
			task.clineMessages[0].text = "mutated"
			task.clineMessages.push({ type: "say", say: "text", text: "later", ts: 4 })
			finish()
			await saving
			expect(mockTaskMetadata).toHaveBeenCalledWith(
				expect.objectContaining({
					messages: [expect.objectContaining({ text: "task", ts: 1 }), expect.objectContaining({ ts: 3 })],
					tokenUsage: expect.objectContaining({ totalTokensIn: 42, totalTokensOut: 7, totalCost: 0.5 }),
				}),
			)
		})

		it("disposal fences new producers and waits for metadata already admitted", async () => {
			const task = createTask()
			let finishMetadata!: () => void
			vi.mocked(mockProvider.updateTaskHistory).mockImplementationOnce(
				() => new Promise((resolve) => (finishMetadata = () => resolve([]))),
			)
			const saving = (task as any).saveClineMessages()
			await vi.waitFor(() => expect(mockProvider.updateTaskHistory).toHaveBeenCalled())
			let disposed = false
			const disposing = task.dispose({ preserveArtifacts: true }).then(() => {
				disposed = true
			})
			await expect((task as any).saveClineMessages()).resolves.toBe(false)
			await expect((task as any).saveClineMessages(true)).rejects.toThrow("closed")
			await expect((task as any).saveApiConversationHistory()).resolves.toBe(false)
			expect(mockSaveTaskMessages).toHaveBeenCalledOnce()
			expect(mockSaveApiMessages).not.toHaveBeenCalled()
			expect(disposed).toBe(false)
			finishMetadata()
			await saving
			await disposing
			expect(disposed).toBe(true)
		})

		it("abort admits one final barrier and propagates durability failures", async () => {
			const task = createTask()
			mockSaveTaskMessages.mockRejectedValueOnce(new Error("disk full"))
			await expect(task.abortTask()).rejects.toThrow("disk full")
			expect(mockSaveTaskMessages).toHaveBeenCalledWith(expect.objectContaining({ barrier: true }))
			await expect(task.dispose()).rejects.toThrow("disk full")
			expect(mockSaveTaskMessages).toHaveBeenCalledOnce()
		})
	})

	// ── flushPendingToolResultsToHistory — save failure/success ───────────

	describe("flushPendingToolResultsToHistory persistence", () => {
		it("retains userMessageContent on save failure", async () => {
			mockSaveApiMessages.mockRejectedValueOnce(new Error("disk full"))

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-fail",
					content: "Result that should be retained",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(false)
			// userMessageContent should NOT be cleared on failure
			expect(task.userMessageContent.length).toBeGreaterThan(0)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "tool-fail",
			})
		})

		it("clears userMessageContent on save success", async () => {
			mockSaveApiMessages.mockResolvedValueOnce(undefined)

			const task = new Task({
				provider: mockProvider,
				apiConfiguration: mockApiConfig,
				task: "test task",
				startTask: false,
			})

			// Skip waiting for assistant message
			task.assistantMessageSavedToHistory = true

			task.userMessageContent = [
				{
					type: "tool_result",
					tool_use_id: "tool-ok",
					content: "Result that should be cleared",
				},
			]

			const saved = await task.flushPendingToolResultsToHistory()

			expect(saved).toBe(true)
			// userMessageContent should be cleared on success
			expect(task.userMessageContent).toEqual([])
		})
	})
})
