import { Task } from "../../Task"
import type { ClineProvider } from "../../../webview/ClineProvider"
import { TerminalRegistry } from "../../../../integrations/terminal/TerminalRegistry"
import { OutputInterceptor } from "../../../../integrations/terminal/OutputInterceptor"
import { buildApiHandler } from "../../../../api"
import { saveApiMessages } from "../../../task-persistence"
import {
	saveRequestSnapshot,
	saveBranchReplay,
	readBranchProvenance,
	readBranchReplaySnapshot,
	type RequestSnapshot,
	type BranchProvenance,
} from "../storage"
import { presentAssistantMessage } from "../../../assistant-message/presentAssistantMessage"
import { getCheckpointService } from "../../../checkpoints"
import { processUserContentMentions } from "../../../mentions/processUserContentMentions"
import { getEnvironmentDetails } from "../../../environment/getEnvironmentDetails"
import { buildNativeToolsArrayWithRestrictions } from "../../build-tools"
import { listFilesTool } from "../../../tools/ListFilesTool"

vi.mock("../../../webview/ClineProvider")
vi.mock("../../../ignore/RooIgnoreController")
vi.mock("../../../protect/RooProtectedController")
vi.mock("../../../context-tracking/FileContextTracker")
vi.mock("../../../../integrations/editor/DiffViewProvider")
vi.mock("../../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getTerminals: vi.fn(() => []), releaseTerminalsForTask: vi.fn() },
}))
vi.mock("../../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async () => "/storage"),
	getTaskDirectoryPath: vi.fn(async () => "/storage/tasks/test"),
}))
vi.mock("../storage", () => ({
	saveRequestSnapshot: vi.fn(),
	saveBranchReplay: vi.fn(),
	readBranchProvenance: vi.fn(),
	readBranchReplaySnapshot: vi.fn(),
}))
vi.mock("../../../task-persistence", () => ({
	saveApiMessages: vi.fn(),
	saveTaskMessages: vi.fn(),
	readApiMessages: vi.fn(async () => []),
	readTaskMessages: vi.fn(async () => []),
	taskMetadata: vi.fn(async () => ({ historyItem: { id: "test" }, tokenUsage: {} })),
}))
vi.mock("../../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../../build-tools", () => ({
	buildNativeToolsArrayWithRestrictions: vi.fn(async () => ({
		tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
	})),
}))
vi.mock("../../../checkpoints", () => ({ getCheckpointService: vi.fn(), checkpointSave: vi.fn() }))
vi.mock("../../../mentions/processUserContentMentions", () => ({ processUserContentMentions: vi.fn() }))
vi.mock("../../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn() }))

const source: RequestSnapshot = {
	version: 1,
	taskId: "source",
	requestId: "request",
	createdAt: 1,
	systemPrompt: "exact saved system prompt",
	apiMessages: [{ role: "user", content: [{ type: "text", text: "saved input" }] }],
	clineMessages: [
		{ ts: 1, type: "say", say: "text", text: "task" },
		{ ts: 2, type: "say", say: "api_req_started", requestId: "request" },
	],
}
const provenance: BranchProvenance = {
	version: 1,
	operationId: "operation",
	kind: "regenerate",
	sourceTaskId: "source",
	sourceRequestId: "request",
	targetProfileId: "profile",
	createdAt: 1,
	workspacePath: "/workspace",
	requiresToolApproval: true,
}

describe("Task model-operation runtime", () => {
	let task: Task
	let provider: any
	let handler: any
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(readBranchProvenance).mockResolvedValue(undefined)
		vi.mocked(readBranchReplaySnapshot).mockResolvedValue(structuredClone(source))
		vi.mocked(saveRequestSnapshot).mockResolvedValue(undefined)
		vi.mocked(saveBranchReplay).mockResolvedValue(provenance)
		vi.mocked(saveApiMessages).mockResolvedValue(undefined)
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
		handler = {
			getModel: vi.fn(() => ({ id: "test", info: { contextWindow: 100000, maxTokens: 1000 } })),
			createMessage: vi.fn(async function* () {
				yield { type: "text", text: "answer" }
			}),
			countTokens: vi.fn(async () => 1),
		}
		vi.mocked(buildApiHandler).mockReturnValue(handler)
		provider = {
			context: { globalStorageUri: { fsPath: "/storage" } },
			getState: vi.fn(async () => ({
				mode: "code",
				organizationAllowList: { allowAll: true, providers: {} },
				autoApprovalEnabled: true,
				alwaysAllowAll: true,
				apiConfiguration: { apiProvider: "anthropic" },
			})),
			providerSettingsManager: {
				getProfile: vi.fn(async () => ({ id: "profile", name: "saved profile", apiProvider: "anthropic" })),
			},
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
			postMessageToWebview: vi.fn(async () => {}),
			updateTaskHistory: vi.fn(async () => {}),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
		task = new Task({
			provider: provider as ClineProvider,
			apiConfiguration: { apiProvider: "anthropic" },
			startTask: false,
			workspacePath: "/workspace",
			taskId: "target",
		})
	})
	afterEach(() => {
		;(task as any).debouncedEmitTokenUsage.cancel()
		vi.restoreAllMocks()
	})

	it("accepts constructor-injected capability and approval restrictions without bypassing branch admission", async () => {
		;(task as any).debouncedEmitTokenUsage.cancel()
		const evaluate = vi.fn(() => ({ allow: true as const }))
		const check = vi.fn(() => ({ decision: "deny" as const, reason: "restricted" }))
		task = new Task({
			provider: provider as ClineProvider,
			apiConfiguration: { apiProvider: "anthropic" },
			startTask: false,
			workspacePath: "/workspace",
			taskId: "target",
			toolInvocationPolicy: { evaluate },
			approvalPort: { check },
		})
		expect(await task.ask("tool", "read request", false)).toEqual({
			response: "noButtonClicked",
			text: "restricted",
		})
		expect(check).toHaveBeenCalledOnce()
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		task.assistantMessageSavedToHistory = true
		task.assistantMessageContent = [
			{ type: "tool_use", id: "call", name: "list_files", params: {}, nativeArgs: { path: "." }, partial: false },
		]
		const handle = vi.spyOn(listFilesTool, "handle").mockResolvedValue()
		const pending = presentAssistantMessage(task)
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		expect(evaluate).toHaveBeenCalledOnce()
		expect(handle).not.toHaveBeenCalled()
		const state = task.modelOperationState
		expect(
			task.respondToModelOperationApproval({
				taskId: state.taskId,
				instanceId: state.instanceId,
				revision: state.revision,
				approvalId: state.approval!.approvalId,
				approved: false,
			}),
		).toBe(true)
		await pending
		expect(handle).not.toHaveBeenCalled()
		expect(check).toHaveBeenCalledOnce()
	})

	async function completedExchange() {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		const waiting = task.admitModelOperationTool("list_files", "completed")
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		const state = task.modelOperationState
		const approval = {
			taskId: state.taskId,
			instanceId: state.instanceId,
			revision: state.revision,
			approvalId: state.approval!.approvalId,
			approved: true,
		}
		expect(task.respondToModelOperationApproval(approval)).toBe(true)
		expect(await waiting).toBe(true)
		task.apiConversationHistory.push(
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "completed", name: "list_files", input: { path: "." } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "completed", content: "actual result" }] },
		)
		task.didCompleteReadingStream = true
		task.userMessageContentReady = true
		task.assistantMessageSavedToHistory = true
		task.didAlreadyUseTool = true
		return approval
	}

	it("runs a real presenter tool loop, publishes the next durable request, and fences without replaying effects", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		let release!: () => void
		const suspended = new Promise<void>((resolve) => {
			release = resolve
		})
		const execute = vi.spyOn(listFilesTool, "handle").mockImplementation(async (_task, _block, callbacks) => {
			expect(task.getModelOperationEvidence().toolsExecuted).toBe(1)
			expect(task.modelOperationState.readiness).toBe("blocked")
			callbacks.pushToolResult("actual filesystem result")
		})
		handler.createMessage
			.mockImplementationOnce(async function* () {
				yield { type: "tool_call", id: "completed", name: "list_files", arguments: '{"path":"."}' }
			})
			.mockImplementationOnce(async function* () {
				await suspended
				yield { type: "tool_call", id: "late", name: "list_files", arguments: '{"path":"."}' }
			})
		task.startModelOperationPrefix()
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		const approvalState = task.modelOperationState
		const approval = {
			taskId: task.taskId,
			instanceId: task.instanceId,
			revision: approvalState.revision,
			approvalId: approvalState.approval!.approvalId,
			approved: true,
		}
		await expect(task.stopForModelOperation(approvalState.revision)).rejects.toThrow("retry at the next request")
		expect(task.respondToModelOperationApproval(approval)).toBe(true)
		await vi.waitFor(
			() =>
				expect(
					handler.createMessage,
					JSON.stringify({
						state: task.modelOperationState,
						history: task.apiConversationHistory,
						ready: task.userMessageContentReady,
						locked: task.presentAssistantMessageLocked,
						executions: execute.mock.calls.length,
					}),
				).toHaveBeenCalledTimes(2),
			{ timeout: 4000 },
		)
		expect(execute).toHaveBeenCalledOnce()
		expect(task.modelOperationState.readiness).toBe("ready")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 0, toolsExecuted: 0 })
		const snapshot = task.getModelOperationEvidence().snapshot!
		expect(snapshot.apiMessages[1].content).toEqual([
			{ type: "tool_use", id: "completed", name: "list_files", input: { path: "." } },
		])
		expect(snapshot.apiMessages[2].content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "tool_result",
					tool_use_id: "completed",
					content: "actual filesystem result",
				}),
			]),
		)
		expect(task.respondToModelOperationApproval(approval)).toBe(false)
		const history = structuredClone(task.apiConversationHistory)
		const ui = structuredClone(task.clineMessages)
		const writes = vi.mocked(saveApiMessages).mock.calls.length
		await task.stopForModelOperation(task.modelOperationState.revision)
		release()
		await new Promise((resolve) => setImmediate(resolve))
		expect(execute).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual(history)
		expect(task.clineMessages).toEqual(ui)
		expect(saveApiMessages).toHaveBeenCalledTimes(writes)
		expect(vi.mocked(saveRequestSnapshot).mock.calls.every(([, snapshot]) => snapshot.taskId === "target")).toBe(
			true,
		)
	})

	it("keeps counters until both history and the next snapshot are durable", async () => {
		const staleApproval = await completedExchange()
		let release!: () => void
		vi.mocked(saveRequestSnapshot).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const iterator = task.attemptApiRequest()
		const pending = iterator.next()
		await vi.waitFor(() => expect(release).toBeDefined())
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 1, toolsExecuted: 1 })
		expect(task.modelOperationState.readiness).toBe("blocked")
		release()
		await pending
		expect(task.modelOperationState.readiness).toBe("ready")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 0, toolsExecuted: 0 })
		expect(task.respondToModelOperationApproval(staleApproval)).toBe(false)
		await iterator.next()
	})

	it.each(["history", "snapshot"])("retains completed-tool counters on %s durability failure", async (failure) => {
		await completedExchange()
		vi.mocked(failure === "history" ? saveApiMessages : saveRequestSnapshot).mockRejectedValueOnce(
			new Error("disk failure"),
		)
		await expect(task.attemptApiRequest().next()).rejects.toThrow("disk failure")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 1, toolsExecuted: 1 })
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it.each(["incomplete", "wrong-result", "missing-admitted-pair"])("fails closed on %s history", async (invalid) => {
		await completedExchange()
		if (invalid === "incomplete") task.apiConversationHistory.pop()
		if (invalid === "wrong-result") (task.apiConversationHistory[2].content as any)[0].tool_use_id = "wrong"
		if (invalid === "missing-admitted-pair") task.apiConversationHistory = structuredClone(source.apiMessages)
		const iterator = task.attemptApiRequest()
		if (invalid === "missing-admitted-pair") {
			await iterator.next()
			await iterator.next()
		} else await expect(iterator.next()).rejects.toThrow("Invalid snapshot")
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 1, toolsExecuted: 1 })
	})

	it.each(["terminal", "edit", "pending-presenter", "unsettled-result"])(
		"does not retire prior effects while %s remains",
		async (work) => {
			await completedExchange()
			if (work === "terminal") vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([{}] as any)
			if (work === "edit") task.diffViewProvider.isEditing = true
			if (work === "pending-presenter") task.presentAssistantMessageHasPendingUpdates = true
			if (work === "unsettled-result") task.userMessageContentReady = false
			const iterator = task.attemptApiRequest()
			await iterator.next()
			await expect(task.stopForModelOperation(task.modelOperationState.revision)).rejects.toThrow()
			expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 1, toolsExecuted: 1 })
			expect(task.abort).toBe(false)
			await iterator.next()
		},
	)

	it("rejects concurrent request entry without clearing current admission or cancelling its approval", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		const iterator = task.attemptApiRequest()
		await iterator.next()
		const waiting = task.admitModelOperationTool("list_files", "current")
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		const before = task.modelOperationState
		await expect(task.attemptApiRequest().next()).rejects.toThrow("already active")
		expect(task.modelOperationState).toEqual(before)
		await iterator.next()
		await expect(task.attemptApiRequest().next()).rejects.toThrow("settlement")
		expect(task.modelOperationState.approval).toEqual(before.approval)
		;(task as any).modelOperationAdmission.cancel()
		expect(await waiting).toBe(false)
		expect(task.getModelOperationEvidence().toolsAdmitted).toBe(1)
	})

	it("preserves fresh target reasoning and signatures after normalizing imported metadata once", async () => {
		const imported = structuredClone(source)
		imported.apiMessages.unshift({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "source reasoning", signature: "source signature" },
				{ type: "text", text: "source answer" },
			],
		})
		await task.prepareModelOperationPrefix(imported, "profile", provenance)
		expect(JSON.stringify(task.apiConversationHistory)).not.toContain("source signature")
		const fresh = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "target reasoning", signature: "target signature" },
				{ type: "text", text: "target answer" },
			],
			reasoning_details: [
				{ type: "reasoning.text", text: "target details", signature: "target detail signature" },
			],
		}
		task.apiConversationHistory.push(fresh as any, { role: "user", content: "continue" })
		const iterator = task.attemptApiRequest()
		await iterator.next()
		expect(handler.createMessage.mock.calls[0][1]).toContainEqual(fresh)
		expect(task.getModelOperationEvidence().snapshot?.apiMessages).toContainEqual(fresh)
		expect(task.modelOperationState.readiness).toBe("ready")
		await iterator.next()
	})

	it("does not erase an admission racing durable snapshot publication", async () => {
		await completedExchange()
		let release!: () => void
		vi.mocked(saveRequestSnapshot).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const iterator = task.attemptApiRequest()
		const pending = iterator.next()
		await vi.waitFor(() => expect(release).toBeDefined())
		expect(await task.admitModelOperationTool("list_files", "racing")).toBe(false)
		release()
		await pending
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 2, toolsExecuted: 1 })
		await iterator.next()
	})

	it("does not publish a snapshot when history changes during persistence", async () => {
		await completedExchange()
		vi.mocked(saveRequestSnapshot).mockImplementationOnce(async () => {
			task.apiConversationHistory.push({ role: "user", content: "concurrent input" })
		})
		const iterator = task.attemptApiRequest()
		await iterator.next()
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(task.getModelOperationEvidence()).toMatchObject({ toolsAdmitted: 1, toolsExecuted: 1 })
		await iterator.next()
	})

	it("honors a synchronous publication fence before creating a replacement abort controller", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		let stopped: Promise<void> | undefined
		provider.postStateToWebviewWithoutTaskHistory.mockImplementation(() => {
			if (task.modelOperationState.readiness === "ready")
				stopped = task.stopForModelOperation(task.modelOperationState.revision)
			return Promise.resolve()
		})
		await expect(task.attemptApiRequest().next()).rejects.toThrow("Stale request dispatch")
		await stopped
		expect(stopped).toBeDefined()
		expect(task.currentRequestAbortController).toBeUndefined()
		expect(handler.createMessage).not.toHaveBeenCalled()
		expect(task.modelOperationDispatchClosed).toBe(true)
	})

	it("uses branch-owned replay on reload and fails closed when it is missing", async () => {
		const local = { ...provenance, replaySnapshotRequestId: "request" }
		vi.mocked(readBranchProvenance).mockResolvedValue(local)
		vi.mocked(readBranchReplaySnapshot).mockResolvedValue(undefined)
		await expect(task.admitModelOperationTool("list_files", "resume")).rejects.toThrow("unavailable")
		expect(readBranchReplaySnapshot).toHaveBeenCalledWith("/storage", "target", local)
		expect(task.modelOperationState.requiresToolApproval).toBe(true)
		expect(task.modelOperationDispatchClosed).toBe(true)
	})

	it("does not publish histories when branch replay or artifact publication fails", async () => {
		vi.mocked(saveBranchReplay).mockRejectedValueOnce(new Error("source artifact changed"))
		await expect(task.prepareModelOperationPrefix(source, "profile", provenance)).rejects.toThrow(
			"artifact changed",
		)
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(saveRequestSnapshot).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toEqual([])
		expect(task.modelOperationDispatchClosed).toBe(true)
		expect(() => task.startModelOperationPrefix()).toThrow()
	})

	it("does not advertise ordinary malformed tool history as ready or repair the source", async () => {
		task.apiConversationHistory = [
			...structuredClone(source.apiMessages),
			{ role: "assistant", content: [{ type: "tool_use", id: "missing", name: "list_files", input: {} }] },
			{ role: "user", content: "not a result" },
		]
		const history = structuredClone(task.apiConversationHistory)
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("prompt")
		const iterator = task.attemptApiRequest()
		await iterator.next()
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(task.getModelOperationEvidence().snapshot).toBeUndefined()
		expect(task.apiConversationHistory).toEqual(history)
		await expect(task.stopForModelOperation(task.modelOperationState.revision)).rejects.toThrow("snapshot")
		await iterator.next()
	})

	it("fences quiescent history with completed tools without rewriting source history", async () => {
		task.isInitialized = true
		task.apiConversationHistory = [
			{ role: "assistant", content: [{ type: "tool_use", id: "past", name: "read_file", input: {} }] },
		]
		;(task as any).modelOperationToolsExecuted = 1
		const original = structuredClone(task.apiConversationHistory)
		expect(task.modelOperationState.readiness).toBe("blocked")
		expect(task.getHistoricalModelOperationBlockReason()).toBeUndefined()
		await task.stopForHistoricalModelOperation(0)
		expect(task.modelOperationState.revision).toBe(1)
		expect(task.modelOperationDispatchClosed).toBe(true)
		expect(task.apiConversationHistory).toEqual(original)
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
		await expect(task.stopForHistoricalModelOperation(0)).rejects.toThrow("Stale")
	})

	it.each([
		"modelOperationLoops",
		"modelOperationRequests",
		"modelOperationUsageCollectors",
		"presentAssistantMessageLocked",
		"isStreaming",
		"isWaitingForFirstChunk",
	])("blocks historical detachment while %s is active", async (field) => {
		task.isInitialized = true
		;(task as any)[field] = 1
		await expect(task.stopForHistoricalModelOperation(0)).rejects.toThrow("Execution is still active")
		expect(task.modelOperationDispatchClosed).toBe(false)
		expect(task.modelOperationState.revision).toBe(0)
	})

	it("blocks historical detachment before initialization and while terminals run", async () => {
		expect(task.getHistoricalModelOperationBlockReason()).toContain("initialization")
		task.isInitialized = true
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([{}] as any)
		await expect(task.stopForHistoricalModelOperation(0)).rejects.toThrow("Stop active terminals")
		expect(task.abort).toBe(false)
	})

	it("requires a settled fence for artifact-preserving disposal", async () => {
		const dispose = vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		expect(() => task.disposeForModelOperation()).toThrow("not settled")
		task.isInitialized = true
		await task.stopForHistoricalModelOperation(0)
		task.disposeForModelOperation()
		expect(dispose).toHaveBeenCalledWith({ preserveArtifacts: true })
	})

	it.each(["historical", "current"])("awaits browser teardown during the %s replacement fence", async (kind) => {
		task.isInitialized = true
		if (kind === "current") {
			vi.spyOn(task as any, "modelOperationBlockReason").mockReturnValue(undefined)
		}
		let finish!: () => void
		const dispose = vi.spyOn(task.browserSession, "dispose").mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		let completed = false
		const stopping = (
			kind === "historical" ? task.stopForHistoricalModelOperation(0) : task.stopForModelOperation(0)
		).then(() => {
			completed = true
		})
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
		expect(completed).toBe(false)
		finish()
		await stopping
		await expect(task.urlContentFetcher.launchBrowser()).rejects.toThrow("disposed")
	})

	it.each(["prepared", "uninitialized reload", "corrupt policy", "ordinary"])(
		"retains branch command evidence during ordinary unload: %s",
		async (kind) => {
			const cleanup = vi.spyOn(OutputInterceptor, "cleanup").mockResolvedValue()
			if (kind === "prepared") await task.prepareModelOperationPrefix(source, "profile", provenance)
			if (kind === "uninitialized reload") vi.mocked(readBranchProvenance).mockResolvedValue(provenance)
			if (kind === "corrupt policy") vi.mocked(readBranchProvenance).mockRejectedValue(new Error("Corrupt"))
			task.dispose()
			await new Promise((resolve) => setImmediate(resolve))
			if (kind === "ordinary") expect(cleanup).toHaveBeenCalledWith("/storage/tasks/test/command-output")
			else expect(cleanup).not.toHaveBeenCalled()
			cleanup.mockRestore()
		},
	)

	it("prepares detached normalized input, saves mandatory provenance before history and pins only the local profile", async () => {
		const copy = structuredClone(source)
		await task.prepareModelOperationPrefix(copy, "profile", provenance)
		copy.apiMessages.length = 0
		expect(task.apiConversationHistory).toEqual(source.apiMessages)
		expect(task.clineMessages).toEqual([source.clineMessages[0]])
		expect(task.enableCheckpoints).toBe(false)
		expect(saveBranchReplay).toHaveBeenCalledWith("/storage", "target", source, provenance)
		expect(saveRequestSnapshot).not.toHaveBeenCalled()
		expect(vi.mocked(saveBranchReplay).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(saveApiMessages).mock.invocationCallOrder[0],
		)
		expect(task.modelOperationState.requiresToolApproval).toBe(true)
		task.updateApiConfiguration({ apiProvider: "openai" })
		task.setTaskApiConfigName("global changed")
		expect(task.apiConfiguration.apiProvider).toBe("anthropic")
		expect(task.taskApiConfigName).toBe("saved profile")
	})

	it.each(["prepare", "restore"])(
		"rejects a disallowed saved profile during %s before dispatch or admission",
		async (phase) => {
			const state = await provider.getState()
			provider.getState.mockResolvedValue({ ...state, organizationAllowList: { allowAll: false, providers: {} } })
			vi.mocked(buildApiHandler).mockClear()
			if (phase === "prepare") {
				await expect(task.prepareModelOperationPrefix(source, "profile", provenance)).rejects.toThrow("policy")
				expect(saveBranchReplay).not.toHaveBeenCalled()
			} else {
				vi.mocked(readBranchProvenance).mockResolvedValue(provenance)
				await expect(task.admitModelOperationTool("read_file", "call")).rejects.toThrow("policy")
			}
			expect(buildApiHandler).not.toHaveBeenCalled()
			expect(handler.createMessage).not.toHaveBeenCalled()
			expect(task.modelOperationDispatchClosed).toBe(true)
			expect(task.modelOperationState.requiresToolApproval).toBe(true)
			expect(task.getModelOperationEvidence().toolsExecuted).toBe(0)
		},
	)

	it("propagates history failures and prevents starting a partially prepared task", async () => {
		provider.updateTaskHistory.mockRejectedValue(new Error("disk failure"))
		await expect(task.prepareModelOperationPrefix(source, "profile", provenance)).rejects.toThrow("disk failure")
		expect(() => task.startModelOperationPrefix()).toThrow()
		expect(task.modelOperationState.readiness).toBe("blocked")
	})

	it("starts neutrally, retains saved empty-response input, and skips mentions, environment, and checkpoints", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		handler.createMessage.mockImplementation(async function* () {})
		task.startModelOperationPrefix()
		await vi.waitFor(() => expect((task as any).modelOperationLoops).toBe(0))
		expect(handler.createMessage).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual(source.apiMessages)
		expect(getCheckpointService).not.toHaveBeenCalled()
		expect(processUserContentMentions).not.toHaveBeenCalled()
		expect(getEnvironmentDetails).not.toHaveBeenCalled()
	})

	it("durably captures before dispatch, keeps revision stable during chunks, and tags actual response rows", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		const iterator = task.attemptApiRequest()
		await iterator.next()
		const state = task.modelOperationState
		expect(state.requestId).toBeTruthy()
		expect(vi.mocked(saveRequestSnapshot).mock.invocationCallOrder[0]).toBeLessThan(
			handler.createMessage.mock.invocationCallOrder[0],
		)
		expect(handler.createMessage.mock.calls[0][0]).toBe(source.systemPrompt)
		expect(handler.createMessage.mock.calls[0][1]).toEqual(source.apiMessages)
		await task.say("text", "answer")
		await (task as any).addToApiConversationHistory({ role: "assistant", content: "answer" })
		expect(task.clineMessages.at(-1)?.requestId).toBe(state.requestId)
		expect(task.apiConversationHistory.at(-1)?.requestId).toBe(state.requestId)
		expect(task.modelOperationState.revision).toBe(state.revision)
		expect(task.getModelOperationEvidence().snapshot?.clineMessages).toEqual([source.clineMessages[0]])
		await iterator.next()
	})

	it("fails closed before dispatch when the snapshot cannot be saved", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		vi.mocked(saveRequestSnapshot).mockRejectedValue(new Error("disk failure"))
		await expect(task.attemptApiRequest().next()).rejects.toThrow("disk failure")
		expect(handler.createMessage).not.toHaveBeenCalled()
		expect(task.modelOperationState.readiness).toBe("blocked")
	})

	it("checks prepared context including output reserve before dispatch without compaction", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		handler.getModel.mockReturnValue({ id: "test", info: { contextWindow: 1000, maxTokens: 1000 } })
		await expect(task.attemptApiRequest().next()).rejects.toThrow("context budget")
		expect(handler.createMessage).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toEqual(source.apiMessages)
	})

	it("budgets serialized tool definitions on every prepared request", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValueOnce({
			tools: [
				{
					type: "function",
					function: { name: "large_tool", description: "x".repeat(100000), parameters: { type: "object" } },
				},
			],
		} as any)
		await expect(task.attemptApiRequest().next()).rejects.toThrow("context budget")
		expect(handler.createMessage).not.toHaveBeenCalled()
	})

	it("does not advertise a stale snapshot while a subsequent request is being prepared", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		const first = task.attemptApiRequest()
		await first.next()
		const oldRevision = task.modelOperationState.revision
		await first.next()
		let release!: () => void
		vi.mocked(saveRequestSnapshot).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const next = task.attemptApiRequest()
		const pending = next.next()
		await vi.waitFor(() => expect(release).toBeDefined())
		expect(task.modelOperationState.revision).toBeGreaterThan(oldRevision)
		expect(task.modelOperationState.requestId).toBeUndefined()
		await expect(task.stopForModelOperation(oldRevision)).rejects.toThrow("Stale")
		release()
		await pending
		await next.next()
	})

	it("isolates mandatory approval from queued messages and normal ask responses", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		const waiting = task.admitModelOperationTool("read_file", "tool-one")
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		const state = task.modelOperationState
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(task.modelOperationState.approval).toBeDefined()
		const payload = {
			taskId: state.taskId,
			instanceId: state.instanceId,
			revision: state.revision,
			approvalId: state.approval!.approvalId,
			approved: true,
		}
		expect(task.respondToModelOperationApproval({ ...payload, revision: state.revision + 1 })).toBe(false)
		expect(task.respondToModelOperationApproval(payload)).toBe(true)
		expect(await waiting).toBe(true)
		expect(task.respondToModelOperationApproval(payload)).toBe(false)
		expect(task.getModelOperationEvidence().toolsExecuted).toBe(1)
		await expect(task.stopForModelOperation(state.revision)).rejects.toThrow("retry at the next request")
		expect(task.abort).toBe(false)
	})

	it("denies delegation and resolves approval false on abort", async () => {
		await task.prepareModelOperationPrefix(source, "profile", provenance)
		expect(await task.admitModelOperationTool("new_task", "delegate")).toBe(false)
		const waiting = task.admitModelOperationTool("custom_tool", "custom")
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		await task.abortTask()
		expect(await waiting).toBe(false)
	})

	it("restores mandatory provenance before admission and fails closed on corruption", async () => {
		vi.mocked(readBranchProvenance).mockResolvedValue(provenance)
		const waiting = task.admitModelOperationTool("read_file", "resume")
		await vi.waitFor(() => expect(task.modelOperationState.approval).toBeDefined())
		expect(task.modelOperationState.profileId).toBe("profile")
		;(task as any).modelOperationAdmission.cancel()
		expect(await waiting).toBe(false)
		;(task as any).modelOperationProvenanceReady = undefined
		vi.mocked(readBranchProvenance).mockRejectedValue(new Error("checksum"))
		await expect(task.admitModelOperationTool("read_file", "corrupt")).rejects.toThrow("checksum")
		expect(task.modelOperationDispatchClosed).toBe(true)
	})

	it("rejects stale revisions and active terminals without aborting the original", async () => {
		;(task as any).modelOperationSnapshot = structuredClone(source)
		await expect(task.stopForModelOperation(1)).rejects.toThrow("Stale")
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([{ busy: true }] as any)
		await expect(task.stopForModelOperation(0)).rejects.toThrow("terminals")
		expect(task.abort).toBe(false)
		expect(task.modelOperationDispatchClosed).toBe(false)
	})

	it("fences synchronously before aborting, preserving old history and never disposing or cancelling the task graph", async () => {
		;(task as any).modelOperationSnapshot = structuredClone(source)
		task.apiConversationHistory = structuredClone(source.apiMessages)
		const dispose = vi.spyOn(task, "dispose")
		const controller = new AbortController()
		task.currentRequestAbortController = controller
		controller.signal.addEventListener("abort", () => expect(task.modelOperationDispatchClosed).toBe(true))
		const stopped = task.stopForModelOperation(0)
		expect(task.modelOperationDispatchClosed).toBe(true)
		await stopped
		expect(controller.signal.aborted).toBe(true)
		expect(dispose).not.toHaveBeenCalled()
		expect(task.apiConversationHistory).toEqual(source.apiMessages)
		expect(task.getModelOperationEvidence().executedContinuationSupported).toBe(false)
	})

	it.each(["tool_use", "mcp_tool_use"])(
		"central presenter holds partial %s and denies custom/native execution before handlers",
		async (type) => {
			task.assistantMessageContent = [{ type, id: "call", name: "custom_tool", partial: true }] as any
			task.assistantMessageSavedToHistory = true
			const admit = vi.spyOn(task, "admitModelOperationTool").mockResolvedValue(false)
			await presentAssistantMessage(task)
			expect(admit).not.toHaveBeenCalled()
			task.assistantMessageContent[0].partial = false
			await presentAssistantMessage(task)
			expect(admit).toHaveBeenCalledWith("custom_tool", "call")
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "call",
				is_error: true,
			})
			expect(task.presentAssistantMessageLocked).toBe(false)
		},
	)

	it.each([false, true])(
		"settles a suspended stream before replacement and drops late chunks (first chunk delivered: %s)",
		async (deliverFirst) => {
			await task.prepareModelOperationPrefix(source, "profile", provenance)
			let release!: () => void
			const suspended = new Promise<void>((resolve) => {
				release = resolve
			})
			handler.createMessage.mockImplementation(async function* () {
				if (deliverFirst) yield { type: "text", text: "first" }
				await suspended
				yield { type: "usage", inputTokens: 999, outputTokens: 999, totalCost: 999 }
				yield { type: "tool_call", id: "late", name: "execute_command", arguments: "{}" }
			})
			task.startModelOperationPrefix()
			await vi.waitFor(() => expect(task.modelOperationState.readiness).toBe("ready"))
			const snapshot = task.getModelOperationEvidence().snapshot
			await task.stopForModelOperation(task.modelOperationState.revision)
			expect((task as any).modelOperationLoops).toBe(0)
			expect((task as any).modelOperationRequests).toBe(0)
			expect(task.presentAssistantMessageLocked).toBe(false)
			const history = structuredClone(task.clineMessages)
			const writes = vi.mocked(saveApiMessages).mock.calls.length
			release()
			await new Promise((resolve) => setImmediate(resolve))
			expect(task.clineMessages).toEqual(history)
			expect(vi.mocked(saveApiMessages).mock.calls).toHaveLength(writes)
			expect(task.getModelOperationEvidence().toolsAdmitted).toBe(0)
			expect(task.assistantMessageContent).toEqual([])
			expect(task.getModelOperationEvidence().snapshot).toEqual(snapshot)
		},
	)

	it("defers global handler changes throughout an ordinary request", async () => {
		task.apiConversationHistory = structuredClone(source.apiMessages)
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("prompt")
		const iterator = task.attemptApiRequest()
		await iterator.next()
		const pinned = task.api
		task.updateApiConfiguration({ apiProvider: "openai" })
		expect(task.api).toBe(pinned)
		expect(task.apiConfiguration.apiProvider).toBe("anthropic")
		await iterator.next()
		expect(task.apiConfiguration.apiProvider).toBe("openai")
		expect((task as any).deferredApiConfiguration).toBeUndefined()
	})

	it("refuses a stop during presenter activity without changing the epoch", async () => {
		;(task as any).modelOperationSnapshot = structuredClone(source)
		task.presentAssistantMessageLocked = true
		await expect(task.stopForModelOperation(0)).rejects.toThrow("presenter")
		expect(task.modelOperationState.revision).toBe(0)
		expect(task.abort).toBe(false)
	})

	it("keeps a timed-out stop fenced and does not dispose the old instance", async () => {
		vi.useFakeTimers()
		try {
			;(task as any).modelOperationSnapshot = structuredClone(source)
			;(task as any).modelOperationLoops = 1
			const dispose = vi.spyOn(task, "dispose")
			const stopped = expect(task.stopForModelOperation(0)).rejects.toThrow()
			await vi.advanceTimersByTimeAsync(5100)
			await stopped
			expect(task.modelOperationDispatchClosed).toBe(true)
			expect(dispose).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})
})
