import { Task } from "../Task"
import { ContextProxy } from "../../config/ContextProxy"
import { buildApiHandler } from "../../../api"
import { AnthropicHandler } from "../../../api/providers/anthropic"
import { ModelDispatchControl, type DispatchAdmission } from "../../../api/dispatch-admission"
import { saveApiMessages } from "../../task-persistence"
import { readBranchProvenance, saveRequestSnapshot } from "../model-operation/storage"
import { attemptCompletionTool } from "../../tools/AttemptCompletionTool"
import { saveContextRecoverySnapshot } from "../../context-management/context-recovery"
import { applyContextWindowOverride } from "../../../shared/api"

vi.mock("../../context-management/context-recovery", async (original) => ({
	...(await original<typeof import("../../context-management/context-recovery")>()),
	saveContextRecoverySnapshot: vi.fn().mockResolvedValue(undefined),
}))

const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock("@anthropic-ai/sdk", () => ({ Anthropic: vi.fn(() => ({ messages: { create } })) }))
vi.mock("../../webview/ClineProvider")
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getTerminals: vi.fn(() => []), releaseTerminalsForTask: vi.fn() },
}))
vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async () => "/storage"),
	getTaskDirectoryPath: vi.fn(async () => "/storage/tasks/test"),
}))
vi.mock("../model-operation/storage", () => ({
	saveRequestSnapshot: vi.fn(),
	saveBranchReplay: vi.fn(),
	readBranchProvenance: vi.fn(),
	readBranchReplaySnapshot: vi.fn(),
}))
vi.mock("../../task-persistence", () => ({
	flushTaskSaves: vi.fn().mockResolvedValue(undefined),
	saveApiMessages: vi.fn(),
	saveTaskMessages: vi.fn(),
	readApiMessages: vi.fn(async () => []),
	readTaskMessages: vi.fn(async () => []),
	taskMetadata: vi.fn(async () => ({ historyItem: { id: "test" }, tokenUsage: {} })),
}))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn(async () => ({ tools: [] })) }))
vi.mock("../../checkpoints", () => ({ getCheckpointService: vi.fn(), checkpointSave: vi.fn() }))
vi.mock("../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn(async () => "environment") }))
vi.mock("../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(async ({ userContent }) => ({ content: userContent })),
}))

describe("Task opt-in model dispatch", () => {
	let task: Task
	let provider: any
	let admit: ReturnType<typeof vi.fn>
	let settle: ReturnType<typeof vi.fn>
	beforeEach(() => {
		vi.clearAllMocks()
		create.mockReset()
		vi.mocked(readBranchProvenance).mockResolvedValue(undefined)
		vi.mocked(saveRequestSnapshot).mockResolvedValue(undefined)
		vi.mocked(saveApiMessages).mockResolvedValue(undefined)
		settle = vi.fn()
		admit = vi.fn(async () => ({ outcome: "budget-denied" }))
		const configuration = { apiProvider: "anthropic" as const, apiModelId: "claude-sonnet-4-6", apiKey: "secret" }
		vi.mocked(buildApiHandler).mockImplementation(() => new AnthropicHandler(configuration))
		provider = {
			contextProxy: new ContextProxy({ globalState: { update: vi.fn(async () => {}) } } as any),
			context: { globalStorageUri: { fsPath: "/storage" } },
			getState: vi.fn(async () => ({
				mode: "code",
				organizationAllowList: { allowAll: true, providers: {} },
				autoApprovalEnabled: true,
				alwaysAllowAll: true,
				autoCondenseContext: false,
				apiConfiguration: configuration,
			})),
			postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
			postMessageToWebview: vi.fn(async () => {}),
			updateTaskHistory: vi.fn(async () => {}),
			log: vi.fn(),
			getSkillsManager: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		}
		task = new Task({
			provider,
			apiConfiguration: configuration,
			startTask: false,
			workspacePath: "/workspace",
			taskId: "target",
			modelDispatchRuntime: { admit },
		})
		vi.spyOn(task as any, "getSystemPrompt").mockResolvedValue("system")
		vi.spyOn(task as any, "getFilesReadByRooSafely").mockResolvedValue([])
		vi.spyOn(task, "say").mockResolvedValue(undefined)
		vi.spyOn(task, "getTokenUsage").mockReturnValue({ contextTokens: 1000 } as any)
		vi.spyOn(AnthropicHandler.prototype, "countTokens").mockResolvedValue(10)
		task.apiConversationHistory = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "next" },
		]
		task.clineMessages = [
			{ ts: 1, type: "say", say: "text", text: "task" },
			{ ts: 2, type: "say", say: "api_req_started" },
		]
	})
	afterEach(() => {
		;(task as any).debouncedEmitTokenUsage.cancel()
		vi.restoreAllMocks()
	})

	it.each([false, true])(
		"restores child lineage and automatically returns with Cordis enabled=%s",
		async (enabled) => {
			await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: enabled })
			const historyItem = {
				id: "restored-child",
				parentTaskId: "parent",
				rootTaskId: "parent",
				status: "active",
				task: "Child",
				ts: 1,
				number: 1,
				totalCost: 0,
				tokensIn: 0,
				tokensOut: 0,
			} as const
			const restored = new Task({
				provider,
				apiConfiguration: (await provider.getState()).apiConfiguration,
				startTask: false,
				workspacePath: "/workspace",
				historyItem,
			})
			provider.getCurrentTask = vi.fn(() => restored)
			provider.getTaskWithId = vi.fn(async () => ({ historyItem }))
			provider.reopenParentFromDelegation = vi.fn(async () => {})
			vi.spyOn(restored, "say").mockResolvedValue(undefined)
			const ask = vi.spyOn(restored, "ask")
			const callbacks = {
				askApproval: vi.fn(),
				pushToolResult: vi.fn(),
				handleError: vi.fn(),
				toolDescription: () => "complete",
			}
			await attemptCompletionTool.execute({ result: "Restored summary" }, restored, callbacks)
			expect(restored.parentTaskId).toBe("parent")
			expect(Boolean((restored as any).modelDispatchRuntime)).toBe(enabled)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(ask).not.toHaveBeenCalled()
			expect(provider.reopenParentFromDelegation).toHaveBeenCalledExactlyOnceWith({
				parentTaskId: "parent",
				childTaskId: "restored-child",
				childInstanceId: restored.instanceId,
				completionResultSummary: "Restored summary",
			})
			restored.dispose({ preserveArtifacts: true })
		},
	)

	it.each(["abort", "modelOperationClosed"])("does not reopen a closed parent during resume: %s", async (flag) => {
		provider.getCurrentTask = vi.fn(() => task)
		;(task as any)[flag] = true
		const loop = vi.spyOn(task as any, "initiateTaskLoop")
		await expect(task.resumeAfterDelegation()).rejects.toThrow("dispatch closed")
		expect((task as any)[flag]).toBe(true)
		expect(loop).not.toHaveBeenCalled()
	})

	it.each([undefined, false, true])("selects ordinary Anthropic preview unless disabled: %s", async (enabled) => {
		// Absent means on (default); only an explicitly stored false is off.
		const on = enabled !== false
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: enabled })
		const ordinary = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
		})
		expect(Boolean((ordinary as any).modelDispatchRuntime)).toBe(on)
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		expect((ordinary as any).previewDispatchDisabled).toBe(on)
		if (on) {
			await expect(ordinary.condenseContext()).rejects.toMatchObject({ code: "cancelled" })
			await expect(ordinary.attemptApiRequest().next()).rejects.toMatchObject({ code: "cancelled" })
		}
		ordinary.dispose({ preserveArtifacts: true })
	})

	it.each(["chat", "manual", "automatic"])(
		"live disable fences pending %s admission, even after re-enable",
		async (path) => {
			if (path === "automatic") {
				provider.getState.mockResolvedValue({
					...(await provider.getState()),
					autoCondenseContext: true,
					autoCondenseContextPercent: 1,
				})
				vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 190000 } as any)
			}
			let grant!: (value: DispatchAdmission) => void
			admit.mockImplementation(
				() =>
					new Promise((resolve) => {
						grant = resolve
					}),
			)
			const before = structuredClone(task.apiConversationHistory)
			const pending = path === "manual" ? task.condenseContext() : task.attemptApiRequest().next()
			await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
			await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
			await expect(pending).rejects.toMatchObject({ code: "cancelled" })
			grant({ outcome: "granted", settle })
			await vi.waitFor(() => expect(settle).toHaveBeenCalledExactlyOnceWith("not-dispatched"))
			await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: true })
			await expect(task.attemptApiRequest().next()).rejects.toMatchObject({ code: "cancelled" })
			await expect(task.condenseContext()).rejects.toMatchObject({ code: "cancelled" })
			expect(task.apiConversationHistory).toEqual(before)
			expect(create).not.toHaveBeenCalled()
			expect(admit).toHaveBeenCalledOnce()
		},
	)

	it.each(["chat", "manual"])("live disable aborts in-flight %s transport without fallback", async (path) => {
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockImplementation(() => new Promise(() => {}))
		const pending = path === "manual" ? task.condenseContext() : task.attemptApiRequest().next()
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
		const signal = create.mock.calls[0][1].signal as AbortSignal
		expect(signal.aborted).toBe(false)
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		expect(signal.aborted).toBe(true)
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
		await expect(task.condenseContext()).rejects.toMatchObject({ code: "cancelled" })
		expect(create).toHaveBeenCalledOnce()
	})

	it("cancels a stream already delivering model output", async () => {
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockResolvedValue(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } }
				await new Promise(() => {})
			})(),
		)
		const iterator = task.attemptApiRequest()
		expect((await iterator.next()).value).toMatchObject({ type: "text", text: "partial" })
		const pending = iterator.next()
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		expect(create.mock.calls[0][1].signal.aborted).toBe(true)
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
	})

	it("keeps a legacy task and its in-flight request unaffected by enable and disable", async () => {
		// The preview is on by default; a legacy task is one created while it is explicitly off.
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		const ordinary = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
		})
		const controller = new AbortController()
		;(ordinary as any).currentRequestAbortController = controller
		const handler = ordinary.api
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: true })
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		expect(controller.signal.aborted).toBe(false)
		expect(ordinary.api).toBe(handler)
		expect((ordinary as any).modelDispatchRuntime).toBeUndefined()
		expect(
			await ordinary.checkToolInvocation({
				type: "tool_use",
				id: "call",
				name: "new_task",
				params: {},
				partial: false,
			}),
		).toEqual({ allow: true })
		ordinary.dispose({ preserveArtifacts: true })
	})

	it("preserves an injected restrictive tool policy while disabled", async () => {
		const evaluate = vi.fn(() => ({ allow: false as const, reason: "Restricted" }))
		const restricted = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
			toolInvocationPolicy: { evaluate },
		})
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		expect(
			await restricted.checkToolInvocation({
				type: "tool_use",
				id: "call",
				name: "new_task",
				params: {},
				partial: false,
			}),
		).toEqual({ allow: false, reason: "Restricted" })
		expect(evaluate).toHaveBeenCalledOnce()
		restricted.dispose({ preserveArtifacts: true })
	})

	it("mediates ordinary opted-in Anthropic requests without imposing budget limits", async () => {
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: true })
		const ordinary = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
		})
		const controller = new AbortController()
		const handler = (ordinary as any).prepareModelDispatch("condensation", controller.signal)
		create.mockResolvedValue(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
				yield { type: "message_stop" }
			})(),
		)
		const chunks = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }]))
			chunks.push(chunk)
		expect(chunks).toContainEqual({ type: "text", text: "answer" })
		expect(create).toHaveBeenCalledOnce()
		expect(create.mock.calls[0][1].signal).toBe(controller.signal)
		expect(admit).not.toHaveBeenCalled()
		ordinary.dispose({ preserveArtifacts: true })
	})

	it("does not replace explicitly injected admission with the permissive preview runtime", async () => {
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: true })
		const restricted = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
			modelDispatchRuntime: { admit },
		})
		const handler = (restricted as any).prepareModelDispatch("condensation", new AbortController().signal)
		await expect(
			handler.createMessage("system", [{ role: "user", content: "hello" }]).next(),
		).rejects.toMatchObject({ code: "budget-denied" })
		expect(admit).toHaveBeenCalledOnce()
		expect(create).not.toHaveBeenCalled()
		restricted.dispose({ preserveArtifacts: true })
	})

	it("uses the saved setting instead of a stale constructor snapshot", async () => {
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		const ordinary = new Task({
			provider,
			apiConfiguration: (await provider.getState()).apiConfiguration,
			startTask: false,
			workspacePath: "/workspace",
			experiments: { cordisRuntimePreview: true },
		})
		expect((ordinary as any).modelDispatchRuntime).toBeUndefined()
		ordinary.dispose({ preserveArtifacts: true })
	})

	it("applies CreateTaskOptions.planOverlay only for cordis tasks", async () => {
		const apiConfiguration = (await provider.getState()).apiConfiguration
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: true })
		const cordis = new Task({
			provider,
			apiConfiguration,
			startTask: false,
			workspacePath: "/w",
			planOverlay: true,
		})
		expect(cordis.profile).toBe("cordis")
		expect(cordis.planOverlay).toBe(true)
		cordis.dispose({ preserveArtifacts: true })

		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		const modes = new Task({ provider, apiConfiguration, startTask: false, workspacePath: "/w", planOverlay: true })
		expect(modes.profile).toBe("modes")
		expect(modes.planOverlay).toBe(false)
		modes.dispose({ preserveArtifacts: true })
	})

	it("restores planOverlay from history on resume, only for cordis items", async () => {
		const apiConfiguration = (await provider.getState()).apiConfiguration
		const base = { number: 1, ts: 1, task: "t", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const resumed = new Task({
			provider,
			apiConfiguration,
			startTask: false,
			historyItem: { ...base, id: "cordis-plan", profile: "cordis", planOverlay: true },
		})
		expect(resumed.planOverlay).toBe(true)
		resumed.dispose({ preserveArtifacts: true })

		const off = new Task({
			provider,
			apiConfiguration,
			startTask: false,
			historyItem: { ...base, id: "cordis-off", profile: "cordis" },
			planOverlay: true,
		})
		expect(off.planOverlay).toBe(false)
		off.dispose({ preserveArtifacts: true })

		const legacy = new Task({
			provider,
			apiConfiguration,
			startTask: false,
			historyItem: { ...base, id: "modes-plan", planOverlay: true },
		})
		expect(legacy.profile).toBe("modes")
		expect(legacy.planOverlay).toBe(false)
		legacy.dispose({ preserveArtifacts: true })
	})

	it("unsubscribes preview settings at teardown", async () => {
		task.dispose({ preserveArtifacts: true })
		await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
		expect((task as any).previewDispatchDisabled).toBe(false)
	})

	it.each(["chat", "manual", "automatic"])(
		"propagates %s denial without dispatch, truncation, history writes or retry",
		async (path) => {
			if (path === "automatic") {
				const state = await provider.getState()
				provider.getState.mockResolvedValue({
					...state,
					autoCondenseContext: true,
					autoCondenseContextPercent: 1,
				})
				vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 190000 } as any)
			}
			const before = structuredClone(task.apiConversationHistory)
			const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
			const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
			await expect(
				path === "manual" ? task.condenseContext() : task.attemptApiRequest().next(),
			).rejects.toMatchObject({ code: "budget-denied" })
			expect(admit).toHaveBeenCalledOnce()
			expect(admit.mock.calls[0][0].purpose).toBe(path === "manual" ? "condensation" : "chat")
			expect(create).not.toHaveBeenCalled()
			expect(backoff).not.toHaveBeenCalled()
			expect(repair).not.toHaveBeenCalled()
			expect(task.apiConversationHistory).toEqual(before)
			if (path === "manual") expect(saveApiMessages).not.toHaveBeenCalled()
			expect(task.modelDispatchOutcome?.code).toBe("budget-denied")
		},
	)

	it("fails unsupported handlers before network or context management", async () => {
		task.api = { createMessage: vi.fn(), getModel: vi.fn(), countTokens: vi.fn() }
		await expect(task.attemptApiRequest().next()).rejects.toMatchObject({ code: "unsupported-provider" })
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(task.api.countTokens).not.toHaveBeenCalled()
		expect(admit).not.toHaveBeenCalled()
	})

	it.each(["chat", "manual", "automatic"])(
		"cancels waiting %s admission and prevents late network work",
		async (path) => {
			if (path === "automatic") {
				provider.getState.mockResolvedValue({
					...(await provider.getState()),
					autoCondenseContext: true,
					autoCondenseContextPercent: 1,
				})
				vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 190000 } as any)
			}
			let grant!: (value: DispatchAdmission) => void
			admit.mockImplementation(
				() =>
					new Promise((resolve) => {
						grant = resolve
					}),
			)
			const pending = path === "manual" ? task.condenseContext() : task.attemptApiRequest().next()
			await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
			task.cancelCurrentRequest()
			await expect(pending).rejects.toMatchObject({ code: "cancelled" })
			grant({ outcome: "granted", settle })
			await vi.waitFor(() => expect(settle).toHaveBeenCalledExactlyOnceWith("not-dispatched"))
			expect(create).not.toHaveBeenCalled()
			if (path === "manual") expect(saveApiMessages).not.toHaveBeenCalled()
		},
	)

	it("does not auto-repair or retry an admitted context-window provider failure", async () => {
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockRejectedValue(new Error("prompt is too long: context length exceeded"))
		await expect(task.attemptApiRequest().next()).rejects.toMatchObject({ code: "dispatch-failed" })
		expect(admit).toHaveBeenCalledOnce()
		expect(create).toHaveBeenCalledOnce()
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
	})

	const overflow = () =>
		Object.assign(new Error("prompt is too long: 200001 tokens > 200000 maximum"), { status: 400 })
	const response = (text = "summary") =>
		(async function* () {
			yield { type: "content_block_start", index: 0, content_block: { type: "text", text } }
			yield { type: "message_stop" }
		})()
	const toolUseOnly = () =>
		(async function* () {
			yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "plan" } }
			yield {
				type: "content_block_start",
				index: 1,
				content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
			}
			yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }
			yield { type: "message_stop" }
		})()
	const thinkingOnly = () =>
		(async function* () {
			yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "plan" } }
			yield { type: "message_stop" }
		})()
	const consume = async (stream: ReturnType<Task["attemptApiRequest"]>) => {
		const chunks = []
		for await (const chunk of stream) chunks.push(chunk)
		return chunks
	}
	const enableOverflow = async (mediated: boolean) => {
		provider.getState.mockResolvedValue({ ...(await provider.getState()), autoCondenseContext: undefined })
		if (!mediated) (task as any).modelDispatchRuntime = undefined
		admit.mockResolvedValue({ outcome: "granted", settle })
	}
	describe("profile context window override", () => {
		const useOverride = (override: number) => {
			task.apiConfiguration = { ...task.apiConfiguration, modelContextWindowOverride: override }
			const getModel = task.api.getModel.bind(task.api)
			vi.spyOn(task.api, "getModel").mockImplementation(() => {
				const model = getModel()
				return {
					...model,
					info: applyContextWindowOverride(model.info, { modelContextWindowOverride: override }),
				}
			})
		}
		it("compacts proactively before dispatch when usage crosses the overridden window", async () => {
			await enableOverflow(false)
			useOverride(64_000)
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 60_000 } as any)
			const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
			create.mockResolvedValueOnce(response()).mockResolvedValueOnce(response("answer"))
			await consume(task.attemptApiRequest())
			expect(repair).toHaveBeenCalledOnce()
			expect(create).toHaveBeenCalledTimes(2) // summary, then the real request; no provider rejection
			expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
		})
		it("dispatches normally while usage fits the overridden window", async () => {
			await enableOverflow(false)
			useOverride(64_000)
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 40_000 } as any)
			const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
			create.mockResolvedValueOnce(response("answer"))
			await consume(task.attemptApiRequest())
			expect(repair).not.toHaveBeenCalled()
			expect(create).toHaveBeenCalledOnce()
		})
		it("accepts a tool-call-only reply after proactive compaction", async () => {
			await enableOverflow(false)
			useOverride(64_000)
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 60_000 } as any)
			create.mockResolvedValueOnce(response()).mockResolvedValueOnce(toolUseOnly())
			const chunks = await consume(task.attemptApiRequest())
			expect(chunks.some((chunk: any) => chunk.type === "tool_call_partial" && chunk.name === "read_file")).toBe(
				true,
			)
		})
		it("still rejects a reasoning-only reply after proactive compaction", async () => {
			await enableOverflow(false)
			useOverride(64_000)
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 60_000 } as any)
			create.mockResolvedValueOnce(response()).mockResolvedValueOnce(thinkingOnly())
			await expect(consume(task.attemptApiRequest())).rejects.toThrow("returned no response")
		})
		it("accepts a tool-call-only reply after a provider-rejected overflow", async () => {
			await enableOverflow(false)
			create
				.mockRejectedValueOnce(overflow())
				.mockResolvedValueOnce(response())
				.mockResolvedValueOnce(toolUseOnly())
			const chunks = await consume(task.attemptApiRequest())
			expect(chunks.some((chunk: any) => chunk.type === "tool_call_partial")).toBe(true)
		})
		it("does not compact proactively when automatic compaction is disabled", async () => {
			admit.mockResolvedValue({ outcome: "granted", settle })
			;(task as any).modelDispatchRuntime = undefined
			useOverride(64_000)
			vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 60_000 } as any)
			const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
			create.mockResolvedValueOnce(response("answer"))
			await consume(task.attemptApiRequest())
			expect(repair).not.toHaveBeenCalled()
		})
	})
	it.each([false, true])("high usage never dispatches a preflight summary, mediated=%s", async (mediated) => {
		await enableOverflow(mediated)
		vi.mocked(task.getTokenUsage).mockReturnValue({ contextTokens: 999999 } as any)
		create.mockResolvedValueOnce(response("answer"))
		await consume(task.attemptApiRequest())
		expect(create).toHaveBeenCalledOnce()
		if (mediated) expect(admit.mock.calls[0][0].purpose).toBe("chat")
	})
	it.each([false, true])(
		"compacts once, persists, and retries once on explicit rejection, mediated=%s",
		async (mediated) => {
			await enableOverflow(mediated)
			const last = structuredClone(task.apiConversationHistory.at(-1))
			create
				.mockRejectedValueOnce(overflow())
				.mockResolvedValueOnce(response())
				.mockResolvedValueOnce(response("answer"))
			await consume(task.attemptApiRequest(8))
			expect(create).toHaveBeenCalledTimes(3)
			expect(task.apiConversationHistory.at(-1)).toEqual(last)
			expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
			expect(saveApiMessages).toHaveBeenCalled()
			expect(saveContextRecoverySnapshot).toHaveBeenCalledWith(
				"/storage",
				expect.objectContaining({
					version: 1,
					taskId: task.taskId,
					apiMessages: expect.arrayContaining([last]),
				}),
			)
			if (mediated)
				expect(admit.mock.calls.map(([descriptor]) => descriptor.purpose)).toEqual([
					"chat",
					"condensation",
					"chat",
				])
		},
	)
	it("accepts a prune-only recovery, snapshots under the prune id, and retries once", async () => {
		await enableOverflow(false)
		const contextManagement = await import("../../context-management")
		const pruned = structuredClone(task.apiConversationHistory)
		const manage = vi.spyOn(contextManagement, "manageContext").mockResolvedValue({
			messages: pruned,
			summary: "",
			cost: 0,
			prevContextTokens: 5000,
			newContextTokens: 1000,
			pruneId: "prune-1",
			prunedCount: 2,
		})
		create.mockRejectedValueOnce(overflow()).mockResolvedValueOnce(response("answer"))
		await consume(task.attemptApiRequest())
		expect(create).toHaveBeenCalledTimes(2)
		expect(manage.mock.calls[0][0]).toMatchObject({ pruneToolResults: true, saveArtifact: expect.any(Function) })
		expect(saveContextRecoverySnapshot).toHaveBeenCalledWith(
			"/storage",
			expect.objectContaining({ eventId: "prune-1" }),
		)
		expect(task.say).toHaveBeenCalledWith(
			"context_pruned",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true },
			undefined,
			undefined,
			{ pruneId: "prune-1", prunedCount: 2, prevContextTokens: 5000, newContextTokens: 1000 },
		)
		manage.mockRestore()
	})
	it.each([false, true])("stops after second rejection despite auto approval, mediated=%s", async (mediated) => {
		await enableOverflow(mediated)
		const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
		create.mockRejectedValueOnce(overflow()).mockResolvedValueOnce(response()).mockRejectedValueOnce(overflow())
		await expect(consume(task.attemptApiRequest())).rejects.toThrow(
			"again after automatic context recovery and its single retry",
		)
		expect(create).toHaveBeenCalledTimes(3)
		expect(backoff).not.toHaveBeenCalled()
	})
	it.each([false, true])("stops on unrelated retry failure after compaction, mediated=%s", async (mediated) => {
		await enableOverflow(mediated)
		const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
		create
			.mockRejectedValueOnce(overflow())
			.mockResolvedValueOnce(response())
			.mockRejectedValueOnce(new Error("network down"))
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(create).toHaveBeenCalledTimes(3)
		expect(backoff).not.toHaveBeenCalled()
	})
	it.each([false, true])("summary rejection does not truncate or retry, mediated=%s", async (mediated) => {
		await enableOverflow(mediated)
		const before = structuredClone(task.apiConversationHistory)
		create.mockRejectedValueOnce(overflow()).mockRejectedValueOnce(overflow())
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(create).toHaveBeenCalledTimes(2)
		expect(task.apiConversationHistory).toEqual(before)
	})
	it.each([false, true])("truncation after compaction overflow shares one retry, mediated=%s", async (mediated) => {
		await enableOverflow(mediated)
		task.apiConversationHistory = [
			{ role: "user", content: "original" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "old input" },
			{ role: "assistant", content: "old answer" },
			{ role: "user", content: "latest input" },
		]
		create.mockRejectedValueOnce(overflow()).mockRejectedValueOnce(overflow()).mockRejectedValueOnce(overflow())
		const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
		await expect(consume(task.attemptApiRequest())).rejects.toThrow("Compact manually")
		expect(create).toHaveBeenCalledTimes(3)
		expect(backoff).not.toHaveBeenCalled()
		expect(task.apiConversationHistory.filter((message) => message.truncationParent)).toHaveLength(2)
		expect(task.say).toHaveBeenCalledWith(
			"sliding_window_truncation",
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			expect.any(Object),
			undefined,
			expect.objectContaining({ messagesRemoved: 2, fallbackReason: "context-limit" }),
		)
	})
	it.each([false, true])(
		"passes the disabled fallback preference through overflow recovery, mediated=%s",
		async (mediated) => {
			await enableOverflow(mediated)
			provider.getState.mockResolvedValue({ ...(await provider.getState()), allowOverflowTruncation: false })
			task.apiConversationHistory = [
				{ role: "user", content: "original" },
				{ role: "assistant", content: "root answer" },
				{ role: "user", content: "older" },
				{ role: "assistant", content: "older answer" },
				{ role: "user", content: "latest" },
			]
			const before = structuredClone(task.apiConversationHistory)
			create.mockRejectedValueOnce(overflow()).mockRejectedValueOnce(overflow())
			await expect(consume(task.attemptApiRequest())).rejects.toThrow("Automatic truncation fallback is disabled")
			expect(create).toHaveBeenCalledTimes(2)
			expect(task.apiConversationHistory).toEqual(before)
		},
	)
	it.each(["cancel", "stale"])("%s during summary does not persist or retry", async (stop) => {
		await enableOverflow(false)
		const before = structuredClone(task.apiConversationHistory)
		create.mockRejectedValueOnce(overflow()).mockImplementationOnce(async () => {
			if (stop === "cancel") task.cancelCurrentRequest()
			else (task as any).modelOperationRevision++
			return response()
		})
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(create).toHaveBeenCalledTimes(2)
		expect(task.apiConversationHistory).toEqual(before)
	})
	it("disabled automatic compaction leaves history intact; manual compaction remains available", async () => {
		const before = structuredClone(task.apiConversationHistory)
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockRejectedValueOnce(overflow())
		await expect(consume(task.attemptApiRequest())).rejects.toThrow("'Compact on context overflow' is disabled")
		expect(create).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual(before)
		create.mockResolvedValueOnce(response())
		await task.condenseContext()
		expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
	})
	it("does not repair after text or tool output", async () => {
		await enableOverflow(false)
		const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
		create.mockResolvedValueOnce(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "started" } }
				throw overflow()
			})(),
		)
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(repair).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledOnce()
	})
	it("prepared requests never repair", async () => {
		await enableOverflow(false)
		;(task as any).modelOperationPrepared = true
		const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
		create.mockRejectedValueOnce(overflow())
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(repair).not.toHaveBeenCalled()
	})
	it.each(["overflow", "network", "summary"])(
		"outer loop does not restart after %s recovery failure",
		async (failure) => {
			await enableOverflow(false)
			create.mockRejectedValueOnce(overflow())
			if (failure === "summary") create.mockRejectedValueOnce(overflow())
			else
				create
					.mockResolvedValueOnce(response())
					.mockRejectedValueOnce(failure === "overflow" ? overflow() : new Error("network down"))
			const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
			await expect(task.recursivelyMakeClineRequests([])).resolves.toBe(true)
			expect(create).toHaveBeenCalledTimes(failure === "summary" ? 2 : 3)
			expect(backoff).not.toHaveBeenCalled()
		},
	)
	it.each(["empty-text", "empty-thinking", "reasoning-only", "whitespace"])(
		"outer loop stops after a recovered response containing only %s",
		async (kind) => {
			await enableOverflow(false)
			const content_block =
				kind === "empty-thinking" || kind === "reasoning-only"
					? {
							type: "thinking",
							thinking: kind === "reasoning-only" ? "thinking without an answer" : "",
							signature: "sig",
						}
					: { type: "text", text: kind === "whitespace" ? " \n" : "" }
			create
				.mockRejectedValueOnce(overflow())
				.mockResolvedValueOnce(response())
				.mockResolvedValueOnce(
					(async function* () {
						yield { type: "content_block_start", index: 0, content_block }
						yield { type: "message_stop" }
					})(),
				)
			const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
			await expect(task.recursivelyMakeClineRequests([])).resolves.toBe(true)
			expect(create).toHaveBeenCalledTimes(3)
			expect(backoff).not.toHaveBeenCalled()
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("no response"))
		},
	)

	it("requires a fresh admission for recovery and does not mutate history on denial", async () => {
		await enableOverflow(true)
		const before = structuredClone(task.apiConversationHistory)
		admit.mockResolvedValueOnce({ outcome: "granted", settle }).mockResolvedValueOnce({ outcome: "budget-denied" })
		create.mockRejectedValueOnce(overflow())
		await expect(consume(task.attemptApiRequest())).rejects.toMatchObject({ code: "budget-denied" })
		expect(create).toHaveBeenCalledOnce()
		expect(task.apiConversationHistory).toEqual(before)
	})
	it("does not retry if repaired history cannot be persisted", async () => {
		await enableOverflow(false)
		create.mockRejectedValueOnce(overflow()).mockResolvedValueOnce(response())
		vi.spyOn(task, "overwriteApiConversationHistory").mockRejectedValueOnce(new Error("disk full"))
		await expect(consume(task.attemptApiRequest())).rejects.toThrow("disk full")
		expect(create).toHaveBeenCalledTimes(2)
	})
	it("suppresses response ID chaining on the repaired retry", async () => {
		await enableOverflow(false)
		const send = vi.spyOn(task.api, "createMessage")
		create
			.mockRejectedValueOnce(overflow())
			.mockResolvedValueOnce(response())
			.mockResolvedValueOnce(response("answer"))
		await consume(task.attemptApiRequest())
		expect(send.mock.calls.at(-1)?.[2]?.suppressPreviousResponseId).toBe(true)
	})
	it.each(["text", "tool_call"])("request does not repair after emitted %s", async (type) => {
		await enableOverflow(false)
		vi.spyOn(task.api, "createMessage").mockImplementation(async function* () {
			yield type === "text"
				? { type: "text", text: "started" }
				: { type: "tool_call", id: "id", name: "read_file", arguments: "{}" }
			throw overflow()
		})
		const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(repair).not.toHaveBeenCalled()
	})
	it.each(["invalid", "rate-limit", "timeout"])("does not compact unrelated %s errors", async (kind) => {
		await enableOverflow(true)
		create.mockRejectedValueOnce(
			Object.assign(new Error("context configuration failed"), {
				status: kind === "invalid" ? 400 : kind === "rate-limit" ? 429 : 408,
			}),
		)
		const repair = vi.spyOn(task as any, "handleContextWindowExceededError")
		await expect(consume(task.attemptApiRequest())).rejects.toThrow()
		expect(repair).not.toHaveBeenCalled()
		expect(create).toHaveBeenCalledOnce()
	})
	it("recognizes explicit structured stream rejection before output", async () => {
		await enableOverflow(false)
		vi.spyOn(task.api, "createMessage").mockImplementationOnce(async function* () {
			yield { type: "usage", inputTokens: 0, outputTokens: 0 }
			yield { type: "error", error: "context_length_exceeded", message: "input rejected" }
		})
		create.mockResolvedValueOnce(response()).mockResolvedValueOnce(response("answer"))
		await consume(task.attemptApiRequest())
		expect(create).toHaveBeenCalledTimes(2)
		expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
	})
	it("cancellation releases a stalled summary and ignores its late result", async () => {
		await enableOverflow(false)
		const before = structuredClone(task.apiConversationHistory)
		let finish!: (value: any) => void
		create.mockRejectedValueOnce(overflow()).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const pending = consume(task.attemptApiRequest())
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
		task.cancelCurrentRequest()
		await expect(pending).rejects.toThrow("cancelled")
		finish(response())
		await new Promise((resolve) => setImmediate(resolve))
		expect(task.apiConversationHistory).toEqual(before)
		expect(create).toHaveBeenCalledTimes(2)
	})
	it("retry admission denial stops after persisted compaction without a new dispatch", async () => {
		await enableOverflow(true)
		admit
			.mockResolvedValueOnce({ outcome: "granted", settle })
			.mockResolvedValueOnce({ outcome: "granted", settle })
			.mockResolvedValueOnce({ outcome: "budget-denied" })
		create.mockRejectedValueOnce(overflow()).mockResolvedValueOnce(response())
		await expect(consume(task.attemptApiRequest())).rejects.toMatchObject({ code: "budget-denied" })
		expect(create).toHaveBeenCalledTimes(2)
		expect(admit).toHaveBeenCalledTimes(3)
		expect(task.apiConversationHistory.some((message) => message.isSummary)).toBe(true)
	})
	it("presents the first chunk without waiting for the next provider chunk", async () => {
		;(task as any).modelOperationPrepared = true
		;(task as any).modelOperationSystemPrompt = "system"
		admit.mockResolvedValue({ outcome: "granted", settle })
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			release = resolve
		})
		create.mockResolvedValue(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "Already here" } }
				await blocked
				throw new Error("test stream ended")
			})(),
		)
		const pending = task.recursivelyMakeClineRequests([])
		const rejected = expect(pending).rejects.toBeInstanceOf(ModelDispatchControl)
		try {
			await vi.waitFor(() =>
				expect(task.assistantMessageContent).toEqual(
					expect.arrayContaining([expect.objectContaining({ type: "text", content: "Already here" })]),
				),
			)
			const info = JSON.parse(task.clineMessages[1].text!)
			expect(info.timing.providerStartedAt).toBeGreaterThanOrEqual(info.timing.startedAt)
			expect(info.timing.firstChunkAt).toBeGreaterThanOrEqual(info.timing.providerStartedAt)
		} finally {
			release()
			await rejected
		}
	})

	it.each(["budget-denied", "stream-failed", "empty"])(
		"preserves %s through the outer task loop without retry",
		async (failure) => {
			// Use the existing prepared-prefix entry path so prompt/environment bootstrap
			// does not obscure the real stream and outer retry catches under test.
			;(task as any).modelOperationPrepared = true
			;(task as any).modelOperationSystemPrompt = "system"
			if (failure === "stream-failed") {
				admit.mockResolvedValue({ outcome: "granted", settle })
				create.mockResolvedValue(
					(async function* () {
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "partial" },
						}
						throw new Error("stream disconnected")
					})(),
				)
			}
			if (failure === "empty") {
				admit.mockResolvedValue({ outcome: "granted", settle })
				create.mockResolvedValue(
					(async function* () {
						yield { type: "message_stop" }
					})(),
				)
			}
			const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
			await expect(task.recursivelyMakeClineRequests([])).rejects.toMatchObject({
				code: failure === "budget-denied" ? failure : "dispatch-failed",
			})
			expect(admit).toHaveBeenCalledOnce()
			expect(create).toHaveBeenCalledTimes(failure === "budget-denied" ? 0 : 1)
			expect(backoff).not.toHaveBeenCalled()
			expect(task.modelDispatchOutcome).toBeInstanceOf(ModelDispatchControl)
		},
	)

	it("rejects overlapping manual and main operations while admission is pending", async () => {
		admit.mockReturnValue(new Promise(() => {}))
		const pending = task.condenseContext()
		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
		await expect(task.condenseContext()).rejects.toMatchObject({ code: "policy-denied" })
		await expect(task.attemptApiRequest().next()).rejects.toMatchObject({ code: "policy-denied" })
		task.cancelCurrentRequest()
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		expect(admit).toHaveBeenCalledOnce()
		expect(create).not.toHaveBeenCalled()
	})

	it("pins the Task request while caller configuration and history change during admission", async () => {
		let grant!: (value: DispatchAdmission) => void
		admit.mockImplementation(
			() =>
				new Promise((resolve) => {
					grant = resolve
				}),
		)
		create.mockResolvedValue(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
				yield { type: "message_stop" }
			})(),
		)
		const stream = task.attemptApiRequest()
		const pending = stream.next()
		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
		task.apiConfiguration.apiModelId = "claude-3-opus-20240229"
		task.apiConversationHistory[0].content = "mutated"
		grant({ outcome: "granted", settle })
		await pending
		while (!(await stream.next()).done) {
			/* drain */
		}
		expect(create.mock.calls[0][0].model).toBe("claude-sonnet-4-6")
		expect(JSON.stringify(create.mock.calls[0][0].messages)).not.toContain("mutated")
		expect(create).toHaveBeenCalledOnce()
	})

	it("ends a text-only mediated turn without a generic use-a-tool retry", async () => {
		;(task as any).modelOperationPrepared = true
		;(task as any).modelOperationSystemPrompt = "system"
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockResolvedValue(
			(async function* () {
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
				yield { type: "message_stop" }
			})(),
		)
		await expect(task.recursivelyMakeClineRequests([])).resolves.toBe(true)
		expect(admit).toHaveBeenCalledOnce()
		expect(create).toHaveBeenCalledOnce()
		expect(settle).toHaveBeenCalledExactlyOnceWith("completed")
	})

	function answerStream() {
		return (async function* () {
			yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
			yield { type: "message_stop" }
		})()
	}

	it.each([false, true])("counts streamed usage once when interrupted=%s", async (interrupted) => {
		;(task as any).modelOperationPrepared = true
		;(task as any).modelOperationSystemPrompt = "system"
		admit.mockResolvedValue({ outcome: "granted", settle })
		vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
			yield { type: "text", text: "answer" }
			if (interrupted) task.didRejectTool = true
			yield { type: "usage", inputTokens: 100, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 100 }
			yield { type: "usage", inputTokens: 0, outputTokens: 7 }
		})
		await task.recursivelyMakeClineRequests([])
		await vi.waitFor(() => {
			const info = JSON.parse(task.clineMessages[1].text!)
			expect(info).toMatchObject({
				tokensIn: 1000,
				tokensOut: 12,
				cacheReads: 800,
				cacheWrites: 100,
				cacheReadTokensReported: true,
			})
		})
	})

	async function waitForResume(count: number) {
		await vi.waitFor(() => {
			expect(task.clineMessages.filter((message) => message.ask === "resume_task")).toHaveLength(count)
			expect(task.isStreaming).toBe(false)
		})
	}

	it("keeps an ordinary text-only preview turn resumable for the next user message", async () => {
		vi.mocked(task.say).mockRestore()
		admit.mockResolvedValue({ outcome: "granted", settle })
		create.mockImplementation(answerStream)
		const loop = (task as any).initiateTaskLoop([{ type: "text", text: "first question" }])
		await waitForResume(1)
		expect(create).toHaveBeenCalledOnce()
		task.handleWebviewAskResponse("messageResponse", "second question")
		await waitForResume(2)
		expect(create).toHaveBeenCalledTimes(2)
		expect(JSON.stringify(create.mock.calls[1][0].messages)).toContain("second question")
		expect(JSON.stringify(create.mock.calls[1][0].messages)).not.toContain("You did not use a tool")
		task.handleWebviewAskResponse("noButtonClicked")
		await expect(loop).resolves.toBeUndefined()
	})

	describe("cordisTextOnlyTurnPolicy", () => {
		const resumeAsks = () => task.clineMessages.filter((message) => message.ask === "resume_task").length
		const usePolicy = async (policy?: "retryThenPause" | "alwaysPause") => {
			provider.getState.mockResolvedValue({ ...(await provider.getState()), cordisTextOnlyTurnPolicy: policy })
		}
		const run = async (streams: Array<() => AsyncGenerator<any>>) => {
			vi.mocked(task.say).mockRestore()
			admit.mockResolvedValue({ outcome: "granted", settle })
			const asksAtCall: number[] = []
			const mistakesAtCall: number[] = []
			for (const stream of streams) {
				create.mockImplementationOnce(() => {
					asksAtCall.push(resumeAsks())
					mistakesAtCall.push(task.consecutiveMistakeCount)
					return stream()
				})
			}
			const loop = (task as any).initiateTaskLoop([{ type: "text", text: "do the work" }])
			return { loop, asksAtCall, mistakesAtCall }
		}
		const finish = async (loop: Promise<unknown>) => {
			task.handleWebviewAskResponse("noButtonClicked")
			await expect(loop).resolves.toBeUndefined()
		}

		it("retries a text-only turn once after a tool turn without asking resume_task", async () => {
			await usePolicy(undefined) // default is retryThenPause
			const { loop, asksAtCall, mistakesAtCall } = await run([toolUseOnly, answerStream, answerStream])
			await waitForResume(1)
			expect(create).toHaveBeenCalledTimes(3)
			expect(JSON.stringify(create.mock.calls[2][0].messages)).toContain("You did not use a tool")
			expect(asksAtCall).toEqual([0, 0, 0]) // the retry went out before any resume_task ask
			expect(task.clineMessages.some((message) => message.text === "MODEL_NO_TOOLS_USED")).toBe(false)
			// The text-only retry and pause add no mistake count of their own.
			expect(task.consecutiveMistakeCount).toBe(mistakesAtCall[1])
			expect(mistakesAtCall[2]).toBe(mistakesAtCall[1])
			await finish(loop)
		})

		it("asks resume_task on the second text-only turn in a row with retryThenPause", async () => {
			await usePolicy("retryThenPause")
			const { loop } = await run([toolUseOnly, answerStream, answerStream])
			await waitForResume(1)
			expect(create).toHaveBeenCalledTimes(3)
			expect(task.consecutiveNoToolUseCount).toBe(0)
			await finish(loop)
			expect(create).toHaveBeenCalledTimes(3)
		})

		it("asks resume_task at once after a tool turn with alwaysPause", async () => {
			await usePolicy("alwaysPause")
			const { loop } = await run([toolUseOnly, answerStream])
			await waitForResume(1)
			expect(create).toHaveBeenCalledTimes(2)
			expect(JSON.stringify(create.mock.calls[1][0].messages)).not.toContain("You did not use a tool")
			await finish(loop)
			expect(create).toHaveBeenCalledTimes(2)
		})
	})

	it("settles the interactive loop when cancelled while waiting at a preview stop", async () => {
		vi.mocked(task.say).mockRestore()
		const loop = (task as any).initiateTaskLoop([{ type: "text", text: "question" }])
		await waitForResume(1)
		await task.abortTask()
		await expect(loop).resolves.toBeUndefined()
		expect(admit).toHaveBeenCalledOnce()
		expect(create).not.toHaveBeenCalled()
	})

	it("clears provider condensation busy state after a real denied admission", async () => {
		const { ClineProvider } =
			await vi.importActual<typeof import("../../webview/ClineProvider")>("../../webview/ClineProvider")
		provider.clineStack = [task]
		const before = structuredClone(task.apiConversationHistory)
		await expect(ClineProvider.prototype.condenseTaskContext.call(provider, task.taskId)).resolves.toBeUndefined()
		expect(admit).toHaveBeenCalledOnce()
		expect(create).not.toHaveBeenCalled()
		expect(task.modelDispatchOutcome?.code).toBe("budget-denied")
		expect(task.apiConversationHistory).toEqual(before)
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "condenseTaskContextResponse",
			text: task.taskId,
		})
	})

	it.each(["budget-denied", "429", "partial", "disabled"])(
		"finalizes an interactive %s stop and waits for explicit input without retrying",
		async (failure) => {
			vi.mocked(task.say).mockRestore()
			const backoff = vi.spyOn(task as any, "backoffAndAnnounce")
			if (failure !== "budget-denied") admit.mockResolvedValue({ outcome: "granted", settle })
			if (failure === "429") create.mockRejectedValue(Object.assign(new Error("rate limited"), { status: 429 }))
			if (failure === "partial") {
				create.mockImplementation(() =>
					(async function* () {
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "partial" },
						}
						throw new Error("disconnected")
					})(),
				)
			}
			if (failure === "disabled") create.mockImplementation(() => new Promise(() => {}))
			const loop = (task as any).initiateTaskLoop([{ type: "text", text: "first question" }])
			if (failure === "disabled") {
				await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
				await provider.contextProxy.setValue("experiments", { cordisRuntimePreview: false })
			}
			await waitForResume(1)
			expect(task.modelDispatchOutcome?.code).toBe(
				failure === "budget-denied"
					? "budget-denied"
					: failure === "disabled"
						? "cancelled"
						: "dispatch-failed",
			)
			expect(task.didFinishAbortingStream).toBe(true)
			expect(task.clineMessages.some((message) => message.partial)).toBe(false)
			const request = [...task.clineMessages].reverse().find((message) => message.say === "api_req_started")!
			expect(JSON.parse(request.text!).cancelReason).toBe("streaming_failed")
			expect(task.clineMessages.some((message) => message.say === "error")).toBe(true)
			expect(admit).toHaveBeenCalledOnce()
			expect(backoff).not.toHaveBeenCalled()
			admit.mockResolvedValue({ outcome: "granted", settle })
			create.mockImplementation(answerStream)
			task.handleWebviewAskResponse("messageResponse", "continue after stop")
			await waitForResume(2)
			// A disabled instance stays fenced, even when the user explicitly continues.
			expect(admit).toHaveBeenCalledTimes(failure === "disabled" ? 1 : 2)
			if (failure !== "disabled") {
				expect(JSON.stringify(create.mock.calls.at(-1)![0].messages)).toContain("continue after stop")
			}
			task.handleWebviewAskResponse("noButtonClicked")
			await expect(loop).resolves.toBeUndefined()
		},
	)

	describe("Cordis profile on a non-Anthropic provider (on by default)", () => {
		const openAiConfiguration = { apiProvider: "openai-native" as const, apiModelId: "gpt-5.1", apiKey: "secret" }
		const makeOpenAiTask = async (experiments: Record<string, boolean | undefined> | undefined) => {
			await provider.contextProxy.setValue("experiments", experiments)
			const cordis = new Task({
				provider,
				apiConfiguration: openAiConfiguration,
				startTask: false,
				workspacePath: "/workspace",
			})
			vi.spyOn(cordis as any, "getSystemPrompt").mockResolvedValue("system")
			vi.spyOn(cordis as any, "getFilesReadByRooSafely").mockResolvedValue([])
			vi.spyOn(cordis, "say").mockResolvedValue(undefined)
			return cordis
		}

		it.each([undefined, {}])("uses the Cordis profile without a dispatch runtime (experiments=%j)", async (exp) => {
			const cordis = await makeOpenAiTask(exp)
			expect(cordis.profile).toBe("cordis")
			expect((cordis as any).modelDispatchRuntime).toBeUndefined()
			cordis.dispose({ preserveArtifacts: true })
		})

		it("uses the modes profile when the flag is stored false", async () => {
			const modes = await makeOpenAiTask({ cordisRuntimePreview: false })
			expect(modes.profile).toBe("modes")
			expect((modes as any).modelDispatchRuntime).toBeUndefined()
			modes.dispose({ preserveArtifacts: true })
		})

		it("gets the Cordis tool set: exit_plan and no switch_mode", async () => {
			const { filterNativeToolsForMode } = await import("../../prompts/tools/filter-tools-for-mode")
			const { getNativeTools } = await import("../../prompts/tools/native-tools")
			const cordis = await makeOpenAiTask({})
			const inputs = cordis.profileToolInputs("code", [], [])
			const names = filterNativeToolsForMode(
				getNativeTools({ supportsImages: false }),
				"code",
				inputs.customModes,
				{},
				undefined,
				{ disabledTools: inputs.disabledTools },
			).map((tool: any) => tool.function.name)
			expect(names).toContain("exit_plan")
			expect(names).not.toContain("switch_mode")
			cordis.dispose({ preserveArtifacts: true })
		})

		it("answers a reply without a tool call with noToolsUsed, not resume_task", async () => {
			const cordis = await makeOpenAiTask({})
			vi.mocked(cordis.say).mockRestore()
			expect(cordis.profile).toBe("cordis")
			const userTurns: string[] = []
			let calls = 0
			vi.spyOn(cordis, "attemptApiRequest").mockImplementation(async function* () {
				calls++
				userTurns.push(JSON.stringify(cordis.apiConversationHistory.at(-1)?.content ?? ""))
				if (calls === 1) {
					yield { type: "text", text: "I think the work is done." }
					return
				}
				;(cordis as any).abort = true
			} as any)
			await (cordis as any).initiateTaskLoop([{ type: "text", text: "do the work" }])
			expect(calls).toBeGreaterThanOrEqual(2)
			expect(userTurns[1]).toContain("You did not use a tool")
			expect(cordis.clineMessages.some((message) => message.ask === "resume_task")).toBe(false)
			cordis.dispose({ preserveArtifacts: true })
		})
	})
})
