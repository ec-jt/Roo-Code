// npx vitest run __tests__/provider-delegation.spec.ts

import { describe, it, expect, vi } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("does not detach the parent or create a child after persistence retries fail", async () => {
		const parent = {
			taskId: "parent-1",
			assertCanDelegate: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(false),
			retrySaveApiConversationHistory: vi.fn().mockResolvedValue(false),
		}
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			getCurrentTask: () => parent,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: parent.taskId } }),
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			removeClineFromStack: vi.fn(),
			createTask: vi.fn(),
		})
		await expect(
			provider.delegateParentAndOpenChild({
				parentTaskId: parent.taskId,
				message: "child",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot delegate")
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
	})

	it("persists parent delegation metadata and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = {
			taskId: "parent-1",
			getTaskMode: vi.fn().mockResolvedValue("orchestrator"),
			apiConfiguration: { apiProvider: "openai", openAiModelId: "parent-model" },
			getTaskApiConfigName: vi.fn().mockResolvedValue("parent-profile"),
			emit: vi.fn(),
			assertCanDelegate: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		} as any

		const childStart = vi.fn()
		const updateTaskHistory = vi.fn()
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: childStart })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockImplementation(async (id: string) => {
			if (id === "parent-1") {
				return {
					historyItem: {
						id: "parent-1",
						task: "Parent",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
						childIds: [],
					},
				}
			}
			// child-1
			return {
				historyItem: {
					id: "child-1",
					task: "Do something",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			}
		})

		const provider = {
			context: { workspaceState: { get: vi.fn().mockReturnValue(false) } },
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			getTaskWithId,
			updateTaskHistory,
			handleModeSwitch,
			updateGlobalState: vi.fn(),
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mode: "orchestrator" }),
		} as unknown as ClineProvider
		Object.setPrototypeOf(provider, ClineProvider.prototype)

		const params = {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		}

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, params)

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)
		// Child task is created with startTask: false and initialStatus: "active"
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			apiConfiguration: parentTask.apiConfiguration,
			initialTaskContext: { mode: "code", apiConfigName: "parent-profile" },
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
		})

		// Metadata persistence - parent gets "delegated" status (child status is set at creation via initialStatus)
		expect(updateTaskHistory).toHaveBeenCalledTimes(1)

		// Parent set to "delegated"
		const parentSaved = updateTaskHistory.mock.calls[0][0]
		expect(parentSaved).toEqual(
			expect.objectContaining({
				id: "parent-1",
				status: "delegated",
				delegatedToId: "child-1",
				awaitingChildId: "child-1",
				childIds: expect.arrayContaining(["child-1"]),
			}),
		)

		// child.start() must be called AFTER parent metadata is persisted
		expect(childStart).toHaveBeenCalledTimes(1)

		// Event emission (provider-level)
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1")

		// Mode switch
		expect(handleModeSwitch).not.toHaveBeenCalled()
	})

	it("calls child.start() only after parent metadata is persisted (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = {
			taskId: "parent-1",
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTaskApiConfigName: vi.fn().mockResolvedValue("parent-profile"),
			apiConfiguration: { apiProvider: "anthropic" },
			emit: vi.fn(),
			assertCanDelegate: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		} as any
		const childStart = vi.fn(() => callOrder.push("child.start"))

		const updateTaskHistory = vi.fn(async () => {
			callOrder.push("updateTaskHistory")
		})
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return { taskId: "child-1", start: childStart }
		})
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({
			historyItem: {
				id: "parent-1",
				task: "Parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				childIds: [],
			},
		})

		const provider = {
			emit: vi.fn(),
			updateGlobalState: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			getTaskWithId,
			updateTaskHistory,
			handleModeSwitch,
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
		} as unknown as ClineProvider
		Object.setPrototypeOf(provider, ClineProvider.prototype)

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		// Verify ordering: createTask → updateTaskHistory → child.start
		expect(callOrder).toEqual(["createTask", "updateTaskHistory", "child.start"])
	})

	function profileFixture(parentMode = "code", locked = false) {
		const parent = {
			taskId: "parent-1",
			instanceId: "parent-instance",
			api: {},
			apiConfiguration: {
				id: "active-id",
				apiProvider: "openai",
				openAiModelId: "active-model",
				openAiHeaders: { "X-Custom": "unsaved-override" },
			},
			getTaskMode: vi.fn().mockResolvedValue(parentMode),
			getTaskApiConfigName: vi.fn().mockResolvedValue("active-profile"),
			assertCanDelegate: vi.fn(),
			flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
			modelOperationState: { revision: 0, nextProfileId: "queued-id" },
		}
		const child = { taskId: "child-1", start: vi.fn() }
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			delegationRevision: 0,
			context: { workspaceState: { get: vi.fn().mockReturnValue(locked) } },
			getCurrentTask: vi.fn(() => parent),
			getState: vi.fn().mockResolvedValue({
				mode: "architect",
				currentApiConfigName: "global-profile",
				apiConfiguration: { id: "global-id", apiProvider: "litellm", litellmModelId: "global-model" },
			}),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: { id: parent.taskId } }),
			removeClineFromStack: vi.fn(),
			handleModeSwitch: vi.fn(),
			updateGlobalState: vi.fn(),
			updateTaskHistory: vi.fn(),
			createTask: vi.fn().mockResolvedValue(child),
			emit: vi.fn(),
			log: vi.fn(),
		})
		const request = { parentTaskId: parent.taskId, mode: "code", message: "child", initialTodos: [] }
		return { parent, provider, child, request }
	}

	it.each([false, true])(
		"inherits active same-mode settings rather than global or queued settings (lock=%s)",
		async (locked) => {
			const { parent, provider, request } = profileFixture("code", locked)
			await provider.delegateParentAndOpenChild(request)
			const options = provider.createTask.mock.calls[0][3]
			expect(options.apiConfiguration).toEqual(parent.apiConfiguration)
			expect(options.apiConfiguration).not.toBe(parent.apiConfiguration)
			expect(options.apiConfiguration.openAiHeaders).not.toBe(parent.apiConfiguration.openAiHeaders)
			expect(options.initialTaskContext).toEqual({ mode: "code", apiConfigName: "active-profile" })
			expect(provider.handleModeSwitch).not.toHaveBeenCalled()
			expect(parent.modelOperationState.nextProfileId).toBe("queued-id")
			expect(provider.updateTaskHistory).toHaveBeenCalledWith(
				expect.objectContaining({ mode: "code", apiConfigName: "active-profile", status: "delegated" }),
			)
		},
	)

	it("inherits the active model instead of the destination profile for an unlocked different-mode child", async () => {
		const { parent, provider, request } = profileFixture("architect")
		provider.removeClineFromStack.mockImplementation(async () => {
			provider.getCurrentTask.mockReturnValue(undefined)
		})
		provider.handleModeSwitch = ClineProvider.prototype.handleModeSwitch
		provider.providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue("code-profile-id"),
			listConfig: vi.fn().mockResolvedValue([{ id: "code-profile-id", name: "code-profile" }]),
			getProfile: vi.fn().mockResolvedValue({ apiProvider: "anthropic" }),
		}
		provider.activateProviderProfile = vi.fn()
		provider.postStateToWebview = vi.fn()
		await provider.delegateParentAndOpenChild(request)
		expect(provider.providerSettingsManager.getModeConfigId).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
		expect(provider.createTask.mock.calls[0][3].apiConfiguration).toEqual(parent.apiConfiguration)
		expect(provider.createTask.mock.calls[0][3].apiConfiguration).not.toBe(parent.apiConfiguration)
	})

	it("records the new_task message timestamp against the created child", async () => {
		const { provider, request } = profileFixture("architect")
		await provider.delegateParentAndOpenChild({ ...request, newTaskMessageTs: 123456 })
		expect(provider.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ newTaskChildLinks: { "123456": "child-1" } }),
		)
	})

	it("preserves existing links and ignores a missing timestamp", async () => {
		const { provider, request } = profileFixture("architect")
		provider.getTaskWithId.mockResolvedValue({
			historyItem: { id: "parent-1", newTaskChildLinks: { "1": "older-child" } },
		})
		await provider.delegateParentAndOpenChild({ ...request, newTaskMessageTs: 2 })
		expect(provider.updateTaskHistory).toHaveBeenCalledWith(
			expect.objectContaining({ newTaskChildLinks: { "1": "older-child", "2": "child-1" } }),
		)
	})

	it("inherits active settings across modes when configuration is locked", async () => {
		const { parent, provider, request } = profileFixture("architect", true)
		await provider.delegateParentAndOpenChild(request)
		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(provider.createTask.mock.calls[0][3].apiConfiguration).toEqual(parent.apiConfiguration)
		expect(provider.updateGlobalState).toHaveBeenCalledWith("mode", "code")
	})

	it("does not create or dispatch a child if destination mode persistence fails", async () => {
		const { provider, child, request } = profileFixture("architect")
		provider.updateGlobalState.mockRejectedValue(new Error("mode persistence failed"))
		await expect(provider.delegateParentAndOpenChild(request)).rejects.toThrow("mode persistence failed")
		expect(provider.createTask).not.toHaveBeenCalled()
		expect(child.start).not.toHaveBeenCalled()
	})

	it("rechecks task identity after awaiting the parent profile metadata", async () => {
		const { parent, provider, request } = profileFixture()
		parent.getTaskApiConfigName.mockImplementation(async () => {
			provider.delegationRevision++
			return "active-profile"
		})
		await expect(provider.delegateParentAndOpenChild(request)).rejects.toThrow("Delegation cancelled")
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(provider.createTask).not.toHaveBeenCalled()
	})
})
