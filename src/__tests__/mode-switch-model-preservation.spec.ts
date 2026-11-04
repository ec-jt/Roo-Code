import { RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"

function fixture(locked = false, inherited = false) {
	const configuration = {
		apiProvider: "openai",
		openAiModelId: "chosen-model",
		openAiHeaders: { "X-Test": "unsaved" },
	}
	const task = {
		taskId: "task",
		_taskMode: "architect",
		apiConfiguration: configuration,
		get taskMode() {
			return this._taskMode
		},
		hasInheritedApiConfiguration: inherited,
		releaseInheritedApiConfigurationLock: vi.fn(),
		emit: vi.fn(),
		setTaskApiConfigName: vi.fn(),
		updateApiConfiguration: vi.fn(),
	}
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		delegationRevision: 0,
		context: { workspaceState: { get: vi.fn(() => locked) } },
		getCurrentTask: vi.fn(() => task),
		getGlobalState: vi.fn((key) => (key === "mode" ? "architect" : [])),
		taskHistoryStore: new Map([["task", { id: "task", mode: "architect", apiConfigName: "chosen-profile" }]]),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		updateGlobalState: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn(),
		emit: vi.fn(),
		log: vi.fn(),
		providerSettingsManager: { getModeConfigId: vi.fn().mockResolvedValue("wrong-profile"), listConfig: vi.fn() },
		activateProviderProfile: vi.fn(),
	})
	return { provider, task, configuration }
}

describe("mode changes preserve task model selection", () => {
	it.each([
		[false, false],
		[false, true],
		[true, false],
		[true, true],
	])("preserves exact active settings with workspace lock=%s inherited=%s", async (locked, inherited) => {
		const { provider, task, configuration } = fixture(locked, inherited)
		await provider.handleModeSwitch("code")
		expect(task.taskMode).toBe("code")
		expect(task.apiConfiguration).toBe(configuration)
		expect(task.updateApiConfiguration).not.toHaveBeenCalled()
		expect(task.setTaskApiConfigName).not.toHaveBeenCalled()
		expect(task.releaseInheritedApiConfigurationLock).not.toHaveBeenCalled()
		expect(provider.providerSettingsManager.getModeConfigId).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
		expect(provider.updateTaskHistory).toHaveBeenCalledWith({
			id: "task",
			mode: "code",
			apiConfigName: "chosen-profile",
		})
		expect(provider.emit).toHaveBeenCalledWith(RooCodeEventName.ModeChanged, "code")
	})
	it("makes same-mode selection a no-op including inherited protection", async () => {
		const { provider, task } = fixture()
		await provider.handleModeSwitch("architect")
		expect(provider.delegationRevision).toBe(0)
		expect(provider.updateTaskHistory).not.toHaveBeenCalled()
		expect(provider.updateGlobalState).not.toHaveBeenCalled()
		expect(task.emit).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})
	it("does not overwrite a replacement task's global mode after persistence awaits", async () => {
		const { provider, task } = fixture()
		provider.updateTaskHistory.mockImplementation(async () =>
			provider.getCurrentTask.mockReturnValue({ ...task, taskId: "replacement" }),
		)
		await expect(provider.handleModeSwitch("code")).rejects.toThrow("Task changed")
		expect(provider.updateGlobalState).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})
})
