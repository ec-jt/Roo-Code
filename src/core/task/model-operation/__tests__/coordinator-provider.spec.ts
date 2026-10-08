import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { RooCodeEventName, type ModelOperationState, type ProviderSettings } from "@roo-code/types"

import { buildApiHandler } from "../../../../api"
import { getModelMaxOutputTokens } from "../../../../shared/api"
import { getStorageBasePath } from "../../../../utils/storage"
import { McpServerManager } from "../../../../services/mcp/McpServerManager"
import { SkillsManager } from "../../../../services/skills/SkillsManager"
import { ClineProvider } from "../../../webview/ClineProvider"
import { Task } from "../../Task"
import { buildNativeToolsArrayWithRestrictions } from "../../build-tools"
import { ModelOperationBlocked, ModelOperationCoordinator, type ModelOperationHost } from "../coordinator"
import { saveRequestSnapshot, type RequestSnapshot } from "../storage"

vi.mock("../../Task", () => ({ Task: vi.fn() }))
vi.mock("../../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn() }))
vi.mock("../../../../shared/api", () => ({ getModelMaxOutputTokens: vi.fn() }))
vi.mock("../../../../utils/storage", () => ({ getStorageBasePath: vi.fn() }))
vi.mock("../../../webview/webviewMessageHandler", () => ({ webviewMessageHandler: vi.fn() }))
vi.mock("../../../../api/providers/fetchers/modelCache")
vi.mock("../../../../integrations/workspace/WorkspaceTracker")
vi.mock("../../../config/ProviderSettingsManager")
vi.mock("../../../config/CustomModesManager")
vi.mock("../../../../services/marketplace")
vi.mock("../../../../services/skills/SkillsManager", () => ({
	SkillsManager: vi.fn().mockImplementation(() => ({ initialize: vi.fn().mockResolvedValue(undefined) })),
}))
vi.mock("../../../../services/mcp/McpServerManager", () => ({
	McpServerManager: {
		getInstance: vi.fn().mockResolvedValue({ registerClient: vi.fn() }),
		unregisterProvider: vi.fn(),
	},
}))
vi.mock("../../../../integrations/openai-codex/oauth", () => ({
	openAiCodexOAuthManager: { isAuthenticated: vi.fn().mockResolvedValue(false) },
}))
vi.mock("../../../../utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../utils/path")>()),
	getWorkspacePath: vi.fn(() => "/test/workspace"),
}))

function makeTask(taskId: string) {
	const task = {
		taskId,
		instanceId: `${taskId}-instance`,
		cwd: "/test/workspace",
		modelOperationState: {
			taskId,
			instanceId: `${taskId}-instance`,
			revision: 4,
			requestId: "request-1",
			readiness: "ready",
			requiresToolApproval: false,
		} as ModelOperationState,
		modelOperationDispatchClosed: false,
		isPaused: false,
		clineMessages: [],
		apiConversationHistory: [],
		getModelOperationEvidence: vi.fn(() => ({ toolsAdmitted: 0, toolsExecuted: 0 })),
		stopForModelOperation: vi.fn(async (_revision: number) => {}),
		prepareModelOperationPrefix: vi.fn().mockResolvedValue(undefined),
		startModelOperationPrefix: vi.fn(),
		respondToModelOperationApproval: vi.fn().mockReturnValue(false),
		handleWebviewAskResponse: vi.fn(),
		abortTask: vi.fn(),
		dispose: vi.fn(),
		disposeForModelOperation: vi.fn(),
		emit: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
	task.stopForModelOperation.mockImplementation(async (revision) => {
		expect(revision).toBe(task.modelOperationState.revision)
		task.modelOperationState = { ...task.modelOperationState, revision: revision + 1 }
		task.modelOperationDispatchClosed = true
	})
	return task
}

// Access private host callbacks to test synchronous compare-and-replace without mocking the coordinator.
function hostOf(provider: ClineProvider): ModelOperationHost<Task> {
	return (provider as any).getModelOperationCoordinator().host
}

describe("ClineProvider model-operation integration", () => {
	let root: string
	let provider: ClineProvider
	let internals: any
	let source: ReturnType<typeof makeTask>
	let branch: ReturnType<typeof makeTask>
	let snapshot: RequestSnapshot
	let savedProfile: ProviderSettings
	let state: any
	let model: any

	beforeEach(async () => {
		vi.clearAllMocks()
		root = await fs.mkdtemp(path.join(os.tmpdir(), "coordinator-provider-"))
		vi.mocked(getStorageBasePath).mockResolvedValue(root)
		source = makeTask("source-1")
		branch = makeTask("branch-1")
		savedProfile = Object.freeze({
			id: "saved-profile",
			apiProvider: "anthropic",
			apiModelId: "selected-model",
			apiKey: "saved-key",
		})
		state = {
			apiConfiguration: { apiProvider: "openrouter", openRouterApiKey: "active-key" },
			organizationAllowList: { allowAll: true },
			mode: "code",
			customModes: [],
			experiments: {},
			disabledTools: ["execute_command"],
			browserToolEnabled: false,
			enableCheckpoints: true,
		}
		model = { id: "selected-model", info: { contextWindow: 100_000, maxTokens: 4096 } }
		vi.mocked(buildApiHandler).mockReturnValue({ getModel: () => model } as any)
		vi.mocked(getModelMaxOutputTokens).mockReturnValue(4096)
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({ tools: [], restrictions: {} } as any)
		vi.mocked(Task).mockImplementation(() => branch as unknown as Task)
		provider = Object.create(ClineProvider.prototype)
		internals = provider
		Object.assign(provider, {
			clineStack: [source],
			_disposed: false,
			context: { globalStorageUri: { fsPath: root }, globalState: { update: vi.fn() } },
			contextProxy: { setValue: vi.fn(), setProviderSettings: vi.fn() },
			providerSettingsManager: {
				getProfile: vi.fn().mockResolvedValue(savedProfile),
				activateProfile: vi.fn(),
			},
			taskHistoryStoreInitialized: true,
			taskHistoryStore: {
				initialized: Promise.resolve(),
				get: vi.fn().mockReturnValue({ id: source.taskId }),
				getAll: vi.fn().mockReturnValue([]),
			},
			taskEventListeners: new WeakMap(),
			taskCreationCallback: vi.fn(),
			getState: vi.fn(async () => state),
			getGlobalState: vi.fn(),
			updateGlobalState: vi.fn(),
			setProviderProfile: vi.fn(),
			activateProviderProfile: vi.fn(),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			removeClineFromStack: vi.fn(),
			addClineToStack: vi.fn(),
			cancelTask: vi.fn(),
			emit: vi.fn(),
			log: vi.fn(),
		})
		snapshot = {
			version: 1,
			taskId: source.taskId,
			requestId: "request-1",
			createdAt: 1,
			apiMessages: [{ role: "user", content: "Continue the saved request." }],
			clineMessages: [],
			systemPrompt: "Saved system prompt",
		}
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	function expectNoGlobalActivation() {
		expect(provider.providerSettingsManager.activateProfile).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
		expect(internals.setProviderProfile).not.toHaveBeenCalled()
		expect(internals.updateGlobalState).not.toHaveBeenCalled()
		expect(provider.context.globalState.update).not.toHaveBeenCalled()
		expect(provider.contextProxy.setValue).not.toHaveBeenCalled()
		expect(provider.contextProxy.setProviderSettings).not.toHaveBeenCalled()
	}

	function expectSourcePreserved() {
		expect(source.abortTask).not.toHaveBeenCalled()
		expect(source.dispose).not.toHaveBeenCalled()
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.addClineToStack).not.toHaveBeenCalled()
		expect(provider.cancelTask).not.toHaveBeenCalled()
	}

	it("uses one real coordinator and the selected saved profile to construct and activate an inert standalone branch", async () => {
		await saveRequestSnapshot(root, snapshot)
		const coordinator = internals.getModelOperationCoordinator()
		expect(coordinator).toBeInstanceOf(ModelOperationCoordinator)
		expect(internals.getModelOperationCoordinator()).toBe(coordinator)
		branch.startModelOperationPrefix.mockImplementation(() => {
			expect(provider.getCurrentTask()).toBe(branch)
			expect(source.modelOperationDispatchClosed).toBe(true)
		})

		const result = await provider.handleModelOperation({
			operationId: "switch-1",
			kind: "switch",
			taskId: source.taskId,
			instanceId: source.instanceId,
			revision: 4,
			profileId: "saved-profile",
			confirmCurrentWorkspace: true,
		})

		expect(result.status).toBe("completed")
		expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledExactlyOnceWith({ id: "saved-profile" })
		expect(buildApiHandler).toHaveBeenCalledExactlyOnceWith(savedProfile)
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledWith(
			expect.objectContaining({
				provider,
				cwd: source.cwd,
				apiConfiguration: savedProfile,
				mode: state.mode,
				customModes: state.customModes,
				disabledTools: state.disabledTools,
				browserToolEnabled: false,
				modelInfo: model.info,
				includeAllToolsWithRestrictions: false,
			}),
		)
		expect(Task).toHaveBeenCalledExactlyOnceWith({
			provider,
			apiConfiguration: savedProfile,
			enableCheckpoints: false,
			experiments: state.experiments,
			workspacePath: source.cwd,
			startTask: false,
		})
		expect(vi.mocked(Task).mock.calls[0][0].apiConfiguration).toBe(savedProfile)
		expect(branch.prepareModelOperationPrefix).toHaveBeenCalledWith(
			snapshot,
			"saved-profile",
			expect.objectContaining({
				sourceTaskId: source.taskId,
				targetProfileId: "saved-profile",
				requiresToolApproval: true,
			}),
		)
		expect(branch.startModelOperationPrefix).toHaveBeenCalledOnce()
		expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: result,
		})
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
		expectSourcePreserved()
		expectNoGlobalActivation()
	})

	it.each([
		"missing profile",
		"policy",
		"context",
		"profile output reserve",
		"handler output reserve",
		"computed output reserve",
		"tool definitions",
	])("blocks %s before constructing or stopping a task", async (reason) => {
		if (reason === "missing profile")
			internals.providerSettingsManager.getProfile.mockRejectedValue(new Error("secret credentials"))
		if (reason === "policy") state.organizationAllowList = { allowAll: false, providers: {} }
		if (reason === "context") model.info.contextWindow = 100
		if (reason === "profile output reserve")
			internals.providerSettingsManager.getProfile.mockResolvedValue({ ...savedProfile, modelMaxTokens: 100_000 })
		if (reason === "handler output reserve") model.maxTokens = 100_000
		if (reason === "computed output reserve") vi.mocked(getModelMaxOutputTokens).mockReturnValue(100_000)
		if (reason === "tool definitions")
			vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
				tools: [{ description: "x".repeat(100_000) }],
			} as any)

		await expect(
			hostOf(provider).createBranch(source as unknown as Task, snapshot, "saved-profile"),
		).rejects.toBeInstanceOf(ModelOperationBlocked)
		expect(Task).not.toHaveBeenCalled()
		expect(source.stopForModelOperation).not.toHaveBeenCalled()
		expect(provider.getCurrentTask()).toBe(source)
		if (reason === "missing profile" || reason === "policy") expect(buildApiHandler).not.toHaveBeenCalled()
		expectSourcePreserved()
		expectNoGlobalActivation()
	})

	it("requests Gemini's full restricted tool set for the explicitly selected profile", async () => {
		internals.providerSettingsManager.getProfile.mockResolvedValue({ ...savedProfile, apiProvider: "gemini" })
		await hostOf(provider).createBranch(source as unknown as Task, snapshot, "saved-profile")
		expect(buildNativeToolsArrayWithRestrictions).toHaveBeenCalledWith(
			expect.objectContaining({ includeAllToolsWithRestrictions: true }),
		)
		expectNoGlobalActivation()
	})

	it("replaces the sole fenced source synchronously and detaches only its listeners", () => {
		source.modelOperationDispatchClosed = true
		const cleanup = vi.fn()
		const otherCleanup = vi.fn()
		internals.taskEventListeners.set(source, [cleanup])
		internals.taskEventListeners.set(branch, [otherCleanup])
		internals.taskCreationCallback.mockImplementation(() => expect(provider.getCurrentTask()).toBe(branch))

		const result = hostOf(provider).activateBranch(source as unknown as Task, branch as unknown as Task)

		expect(result).toBeUndefined()
		expect(internals.clineStack).toEqual([branch])
		expect(cleanup).toHaveBeenCalledOnce()
		expect(otherCleanup).not.toHaveBeenCalled()
		expect(internals.taskEventListeners.has(source)).toBe(false)
		expect(internals.taskEventListeners.has(branch)).toBe(true)
		expect(internals.taskCreationCallback).toHaveBeenCalledExactlyOnceWith(branch)
		expect(provider.emit).toHaveBeenCalledWith(RooCodeEventName.TaskUnfocused, source.taskId)
		expect(branch.emit).toHaveBeenCalledWith(RooCodeEventName.TaskFocused)
		expectSourcePreserved()
	})

	it.each(["unfenced", "disposed", "replaced", "nested", "empty"])(
		"rejects %s source activation without side effects",
		(reason) => {
			source.modelOperationDispatchClosed = reason !== "unfenced"
			if (reason === "disposed") internals._disposed = true
			if (reason === "replaced") internals.clineStack = [makeTask("replacement")]
			if (reason === "nested") internals.clineStack = [makeTask("parent"), source]
			if (reason === "empty") internals.clineStack = []
			const before = [...internals.clineStack]
			const cleanup = vi.fn()
			internals.taskEventListeners.set(source, [cleanup])
			expect(() => hostOf(provider).activateBranch(source as unknown as Task, branch as unknown as Task)).toThrow(
				ModelOperationBlocked,
			)
			expect(internals.clineStack).toEqual(before)
			expect(cleanup).not.toHaveBeenCalled()
			expect(internals.taskCreationCallback).not.toHaveBeenCalled()
			expect(branch.emit).not.toHaveBeenCalled()
			expectSourcePreserved()
		},
	)

	it.each([
		undefined,
		{ rootTaskId: "root" },
		{ parentTaskId: "parent" },
		{ childIds: ["child"] },
		{ delegatedToId: "child" },
		{ awaitingChildId: "child" },
		{ completedByChildId: "child" },
		{ status: "delegated" },
	])("rejects missing or graph-linked persisted history: %j", async (history) => {
		internals.taskHistoryStore.get.mockReturnValue(history)
		await expect(hostOf(provider).validateStandalone(source as unknown as Task)).rejects.toBeInstanceOf(
			ModelOperationBlocked,
		)
		expect(Task).not.toHaveBeenCalled()
		expectSourcePreserved()
	})

	it("discards only the unactivated branch", () => {
		hostOf(provider).discardBranch(branch as unknown as Task)
		expect(branch.dispose).toHaveBeenCalledOnce()
		expectSourcePreserved()
	})

	it.each([true, false])(
		"routes dedicated approval to the live task and publishes acceptance %s",
		async (accepted) => {
			source.respondToModelOperationApproval.mockReturnValue(accepted)
			const payload = {
				taskId: source.taskId,
				instanceId: source.instanceId,
				revision: 4,
				approvalId: "approval-1",
				approved: true,
			}
			const result = await provider.handleModelOperationApproval(payload)
			expect(result.status).toBe(accepted ? "completed" : "blocked")
			expect(source.respondToModelOperationApproval).toHaveBeenCalledExactlyOnceWith(payload)
			expect(source.handleWebviewAskResponse).not.toHaveBeenCalled()
			expect(provider.postStateToWebview).toHaveBeenCalledOnce()
			expect(provider.postMessageToWebview).toHaveBeenLastCalledWith({
				type: "modelOperationStatus",
				modelOperationStatus: result,
			})
		},
	)

	it.each([undefined, null, {}, { approvalId: "approval-1", approved: true }])(
		"blocks invalid dedicated payloads without ordinary approval: %j",
		async (payload) => {
			expect((await provider.handleModelOperation(payload)).status).toBe("blocked")
			expect((await provider.handleModelOperationApproval(payload)).status).toBe("blocked")
			expect(source.respondToModelOperationApproval).not.toHaveBeenCalled()
			expect(source.handleWebviewAskResponse).not.toHaveBeenCalled()
			expect(Task).not.toHaveBeenCalled()
		},
	)

	it("exposes the live model-operation state on every ExtensionState read, not saved global state", async () => {
		state.modelOperation = { revision: -1 }
		expect((await provider.getStateToPostToWebview()).modelOperation).toBe(source.modelOperationState)
		source.modelOperationState = {
			...source.modelOperationState,
			revision: 5,
			readiness: "blocked",
			reason: "Dispatch closed",
		}
		expect((await provider.getStateToPostToWebview()).modelOperation).toBe(source.modelOperationState)
		internals.clineStack = [branch]
		expect((await provider.getStateToPostToWebview()).modelOperation).toBe(branch.modelOperationState)
		internals.clineStack = []
		expect((await provider.getStateToPostToWebview()).modelOperation).toBeUndefined()
	})

	it.each([true, false])(
		"normal streaming-failure rehydration respects the model-operation fence: %s",
		async (fenced) => {
			vi.spyOn(ClineProvider.prototype as any, "initializeTaskHistoryStore").mockResolvedValue(undefined)
			vi.spyOn(ClineProvider.prototype as any, "updateGlobalState").mockResolvedValue(undefined)
			vi.mocked(McpServerManager.getInstance).mockResolvedValue({ registerClient: vi.fn() } as any)
			vi.mocked(SkillsManager).mockImplementation(
				() => ({ initialize: vi.fn().mockResolvedValue(undefined) }) as any,
			)
			const constructed = new ClineProvider(provider.context, { appendLine: vi.fn() } as any, "sidebar", {
				globalStorageUri: { fsPath: root },
			} as any)
			try {
				const task = Object.assign(source, {
					abortReason: "streaming_failed",
					rootTask: undefined,
					parentTask: undefined,
				})
				task.modelOperationDispatchClosed = fenced
				;(constructed as any).clineStack = [task]
				constructed.getTaskWithId = vi.fn().mockResolvedValue({ historyItem: { id: task.taskId } })
				constructed.createTaskWithHistoryItem = vi.fn().mockResolvedValue(branch as unknown as Task)
				;(constructed as any).taskCreationCallback(task)
				const aborted = task.on.mock.calls.filter(([event]) => event === RooCodeEventName.TaskAborted)
				expect(aborted.length).toBeGreaterThan(0)
				for (const [, listener] of aborted) await listener()
				if (fenced) {
					expect(constructed.getTaskWithId).not.toHaveBeenCalled()
					expect(constructed.createTaskWithHistoryItem).not.toHaveBeenCalled()
				} else {
					expect(constructed.getTaskWithId).toHaveBeenCalledExactlyOnceWith(task.taskId)
					expect(constructed.createTaskWithHistoryItem).toHaveBeenCalledExactlyOnceWith(
						{ id: task.taskId, rootTask: undefined, parentTask: undefined },
						{ internal: true, assertCurrent: expect.any(Function) },
					)
				}
			} finally {
				// Avoid normal disposal, which would delete the source task's artifacts.
				;(ClineProvider as any).activeInstances.delete(constructed)
			}
		},
	)
})
