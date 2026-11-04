// npx vitest run core/task/__tests__/Task.sticky-profile-race.spec.ts

import * as vscode from "vscode"

import type { ProviderSettings, ProviderSettingsWithId } from "@roo-code/types"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

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
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: any) => d })),
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
		version: "1.85.0",
	}
})

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

describe("Task - sticky provider profile init race", () => {
	it.each(["active-profile", undefined])(
		"creates a deferred child with explicit identity (%s), not UI defaults",
		async (apiConfigName) => {
			const inheritedConfiguration: ProviderSettingsWithId = {
				id: "active-id",
				apiProvider: "anthropic",
				apiModelId: "claude-3-5-sonnet-20241022",
				modelTemperature: 0.42,
			}
			const provider = Object.assign(Object.create(ClineProvider.prototype), {
				context: { globalStorageUri: { fsPath: "/test/storage" } },
				clineStack: [],
				setValues: vi.fn(),
				getState: vi.fn().mockResolvedValue({
					mode: "architect",
					currentApiConfigName: "global-profile",
					apiConfiguration: { apiProvider: "litellm", litellmModelId: "global-model" },
					organizationAllowList: { allowAll: true, providers: {} },
				}),
				addClineToStack: vi.fn(),
				log: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
			})
			const start = vi.spyOn(Task.prototype, "start").mockImplementation(() => {})
			try {
				const child = await provider.createTask(
					"child",
					undefined,
					{ workspacePath: "/test/workspace" } as Task,
					{
						startTask: false,
						apiConfiguration: inheritedConfiguration,
						initialTaskContext: { mode: "code", apiConfigName },
					},
				)
				expect(child.apiConfiguration).toEqual(inheritedConfiguration)
				expect(await child.getTaskMode()).toBe("code")
				expect(await child.getTaskApiConfigName()).toBe(apiConfigName)
				expect(child.modelOperationState.nextProfileId).toBeUndefined()
				expect(start).not.toHaveBeenCalled()
			} finally {
				start.mockRestore()
			}
		},
	)

	it("validates the inherited configuration against the organization allowlist", async () => {
		const provider = Object.assign(Object.create(ClineProvider.prototype), {
			setValues: vi.fn(),
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "anthropic" },
				organizationAllowList: { allowAll: false, providers: { anthropic: { allowAll: true } } },
			}),
			addClineToStack: vi.fn(),
		})
		await expect(
			provider.createTask("child", undefined, {} as Task, {
				startTask: false,
				apiConfiguration: { apiProvider: "litellm" },
			}),
		).rejects.toThrow()
		expect(provider.addClineToStack).not.toHaveBeenCalled()
	})

	it("does not overwrite task apiConfigName if set during async initialization", async () => {
		const apiConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		} as any

		let resolveGetState: ((v: any) => void) | undefined
		const getStatePromise = new Promise((resolve) => {
			resolveGetState = resolve
		})

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockImplementation(() => getStatePromise),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			provider: mockProvider,
			apiConfiguration: apiConfig,
			task: "test task",
			startTask: false,
		})

		// Simulate a profile switch happening before provider.getState resolves.
		task.setTaskApiConfigName("new-profile")

		resolveGetState?.({ currentApiConfigName: "old-profile" })
		await task.waitForApiConfigInitialization()

		expect(task.taskApiConfigName).toBe("new-profile")
	})

	it("ignores incidental ProviderProfileChanged while the child's inherited configuration is pinned", async () => {
		const inherited: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "parent-key",
		} as any

		const listeners = new Map<string, Array<() => void | Promise<void>>>()
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				currentApiConfigName: "global-profile",
				apiConfiguration: { apiProvider: "litellm", litellmModelId: "incidental-model" },
			}),
			getCurrentTask: vi.fn(),
			log: vi.fn(),
			on: vi.fn((event: string, handler: () => void) => {
				if (!listeners.has(event)) listeners.set(event, [])
				listeners.get(event)!.push(handler)
			}),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			provider,
			apiConfiguration: inherited,
			task: "child",
			startTask: false,
			initialTaskContext: { mode: "code", apiConfigName: "parent-profile" },
		})
		// Delegation inheritance engaged
		expect((task as any).hasInheritedApiConfiguration).toBe(true)
		;(provider.getCurrentTask as any).mockReturnValue(task)

		// Fire an incidental global ProviderProfileChanged (e.g., from webview launch
		// reconciliation, profile upsert, rename, or history resume on a sibling).
		const handlers = listeners.get("providerProfileChanged") ?? []
		expect(handlers.length).toBeGreaterThan(0)
		for (const handler of handlers) await handler()

		// Inherited configuration must survive: no rebuild, no key change.
		expect(task.apiConfiguration.apiProvider).toBe("anthropic")
		expect(task.apiConfiguration.apiModelId).toBe("claude-3-5-sonnet-20241022")
		expect((task.apiConfiguration as any).apiKey).toBe("parent-key")

		// Clearing the lock lets the next event take effect normally.
		;(task as any).releaseInheritedApiConfigurationLock()
		for (const handler of handlers) await handler()
		expect(task.apiConfiguration.apiProvider).toBe("litellm")
	})

	it("ignores ProviderProfileChanged addressed to a non-current (background) task", async () => {
		const inherited: ProviderSettings = { apiProvider: "anthropic", apiModelId: "claude-m" } as any
		const listeners = new Map<string, Array<() => void | Promise<void>>>()
		const provider = {
			context: { globalStorageUri: { fsPath: "/test/storage" } },
			getState: vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "litellm", litellmModelId: "incidental-model" },
			}),
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			log: vi.fn(),
			on: vi.fn((event: string, handler: () => void) => {
				if (!listeners.has(event)) listeners.set(event, [])
				listeners.get(event)!.push(handler)
			}),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			provider,
			apiConfiguration: inherited,
			task: "non-current",
			startTask: false,
		})
		// Not inherited; the identity gate alone must block cross-task writes.
		expect((task as any).hasInheritedApiConfiguration).toBe(false)

		const handlers = listeners.get("providerProfileChanged") ?? []
		for (const handler of handlers) await handler()

		expect(task.apiConfiguration.apiProvider).toBe("anthropic")
		expect(task.apiConfiguration.apiModelId).toBe("claude-m")
	})
})
