// npx vitest run __tests__/delegation-inherited-config-guard.spec.ts
//
// Regression coverage for the v4.2.48 same-mode / lock-across-modes inheritance:
// after `performDelegation` clones the parent's `apiConfiguration` into the
// child, incidental global profile activations (webview launch reconciliation,
// upsert/rename/load/delete of unrelated profiles, history resume) must NOT
// rewrite the child's task-local configuration or sticky-profile name.
// Explicit per-task changes DO release the lock.

import { RooCodeEventName } from "@roo-code/types"
import type { ProviderSettings } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"

type AnyProvider = any

/**
 * Build a provider stub shaped like the real one for `activateProviderProfile`
 * -> `updateTaskApiHandlerIfNeeded` + `persistStickyProviderProfileToCurrentTask`.
 * Not a full ClineProvider: enough to exercise the two guarded methods.
 */
function buildProvider(child: AnyProvider): AnyProvider {
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		delegationRevision: 0,
		taskHistoryStore: new Map<string, unknown>(),
		getGlobalState: vi.fn().mockReturnValue([]),
		getCurrentTask: vi.fn(() => child),
		contextProxy: {
			setValue: vi.fn(),
			setProviderSettings: vi.fn(),
		},
		providerSettingsManager: {
			activateProfile: vi.fn().mockImplementation(async (args: { name?: string; id?: string }) => ({
				name: args.name ?? "incidental-profile",
				id: args.id ?? "incidental-id",
				apiProvider: "litellm",
				litellmModelId: "incidental-model",
			})),
			listConfig: vi.fn().mockResolvedValue([]),
			setModeConfig: vi.fn(),
		},
		getState: vi.fn().mockResolvedValue({
			mode: "code",
			currentApiConfigName: "incidental-profile",
			apiConfiguration: { apiProvider: "litellm", litellmModelId: "incidental-model" },
		}),
		postStateToWebview: vi.fn(),
		updateTaskHistory: vi.fn(),
		emit: vi.fn(),
		log: vi.fn(),
	})
	return provider
}

/**
 * Build a child stub exposing the inherited lock + the mutating APIs the
 * provider update paths call.
 */
function buildChildTask(opts: { inherited: boolean }): AnyProvider {
	const inherited: ProviderSettings = {
		apiProvider: "anthropic",
		apiModelId: "claude-3-5-sonnet-20241022",
		modelTemperature: 0.42,
	} as any
	return {
		taskId: "child-1",
		instanceId: "child-inst",
		apiConfiguration: { ...inherited },
		api: { getModel: () => ({ id: inherited.apiModelId, info: {} }) },
		_taskApiConfigName: "parent-profile",
		updateApiConfiguration: vi.fn(function (this: AnyProvider, cfg: ProviderSettings) {
			this.apiConfiguration = cfg
		}),
		setTaskApiConfigName: vi.fn(function (this: AnyProvider, name: string) {
			this._taskApiConfigName = name
		}),
		get hasInheritedApiConfiguration() {
			return opts.inherited
		},
		releaseInheritedApiConfigurationLock() {
			opts.inherited = false
		},
	}
}

describe("Delegation-inherited configuration: incidental activation guard", () => {
	let provider: AnyProvider
	let child: AnyProvider

	beforeEach(() => {
		child = buildChildTask({ inherited: true })
		provider = buildProvider(child)
	})

	it("does not rewrite the inherited task.apiConfiguration via updateTaskApiHandlerIfNeeded", async () => {
		const snapshot = { ...child.apiConfiguration }
		;(provider as any).updateTaskApiHandlerIfNeeded(
			{ apiProvider: "litellm", litellmModelId: "incidental-model" } as ProviderSettings,
			{ forceRebuild: true },
		)
		expect(child.updateApiConfiguration).not.toHaveBeenCalled()
		expect(child.apiConfiguration).toEqual(snapshot)
	})

	it("does not rewrite the inherited task sticky profile name via persistStickyProviderProfileToCurrentTask", async () => {
		await (provider as any).persistStickyProviderProfileToCurrentTask("incidental-profile")
		expect(child.setTaskApiConfigName).not.toHaveBeenCalled()
		expect(child._taskApiConfigName).toBe("parent-profile")
	})

	it("activateProviderProfile combines both guards: inherited child retains parent configuration and name", async () => {
		await (ClineProvider.prototype as any).activateProviderProfile.call(provider, { name: "incidental-profile" })
		expect(child.updateApiConfiguration).not.toHaveBeenCalled()
		expect(child.setTaskApiConfigName).not.toHaveBeenCalled()
		expect(child.apiConfiguration.apiModelId).toBe("claude-3-5-sonnet-20241022")
		expect(child._taskApiConfigName).toBe("parent-profile")
		// The provider still emits ProviderProfileChanged for other listeners (UI),
		// but the child's task-local state must remain inherited.
		expect(provider.emit).toHaveBeenCalledWith(
			RooCodeEventName.ProviderProfileChanged,
			expect.objectContaining({ name: "incidental-profile" }),
		)
	})

	it("after releaseInheritedApiConfigurationLock(), subsequent incidental activation DOES apply", async () => {
		child.releaseInheritedApiConfigurationLock()
		;(provider as any).updateTaskApiHandlerIfNeeded(
			{ apiProvider: "litellm", litellmModelId: "incidental-model" } as ProviderSettings,
			{ forceRebuild: true },
		)
		expect(child.updateApiConfiguration).toHaveBeenCalledTimes(1)
		expect(child.apiConfiguration.litellmModelId).toBe("incidental-model")
	})

	it("non-inherited current task is updated normally (guards do not over-trigger)", async () => {
		const normalChild = buildChildTask({ inherited: false })
		const provider2 = buildProvider(normalChild)
		;(provider2 as any).updateTaskApiHandlerIfNeeded(
			{ apiProvider: "litellm", litellmModelId: "incidental-model" } as ProviderSettings,
			{ forceRebuild: true },
		)
		expect(normalChild.updateApiConfiguration).toHaveBeenCalledTimes(1)
		expect(normalChild.apiConfiguration.litellmModelId).toBe("incidental-model")
	})
	it("explicit profile selection releases inheritance and updates configuration and identity", async () => {
		await provider.activateProviderProfile({ name: "chosen" }, { explicitTaskSelection: true })
		expect(child.hasInheritedApiConfiguration).toBe(false)
		expect(child.apiConfiguration.litellmModelId).toBe("incidental-model")
		expect(child.setTaskApiConfigName).toHaveBeenCalledWith("chosen")
	})
	it("does not target a newly foregrounded task when activation finishes late", async () => {
		const replacement = buildChildTask({ inherited: false })
		provider.providerSettingsManager.activateProfile.mockImplementation(async () => {
			provider.getCurrentTask.mockReturnValue(replacement)
			return { name: "old-choice", id: "id", apiProvider: "litellm", litellmModelId: "late" }
		})
		await provider.activateProviderProfile({ name: "old-choice" }, { explicitTaskSelection: true })
		expect(replacement.updateApiConfiguration).not.toHaveBeenCalled()
		expect(replacement.setTaskApiConfigName).not.toHaveBeenCalled()
		expect(provider.emit).not.toHaveBeenCalled()
	})
})
