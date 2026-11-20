// npx vitest run core/webview/__tests__/webviewMessageHandler.profileFinishedTask.spec.ts

import * as vscode from "vscode"

import { webviewMessageHandler } from "../webviewMessageHandler"

vi.mock("../../task-persistence", () => ({ saveTaskMessages: vi.fn() }))
vi.mock("../../../i18n", () => ({ t: vi.fn((key: string) => key), changeLanguage: vi.fn() }))
vi.mock("vscode", () => ({
	window: { showErrorMessage: vi.fn(), showWarningMessage: vi.fn(), showInformationMessage: vi.fn() },
	workspace: { workspaceFolders: undefined, getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })) },
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	Uri: { parse: vi.fn((str) => ({ toString: () => str })), file: vi.fn((path) => ({ fsPath: path })) },
	env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn() } },
	commands: { executeCommand: vi.fn() },
}))

describe("webviewMessageHandler profile delete/select", () => {
	let provider: any
	let currentApiConfigName: string

	beforeEach(() => {
		vi.clearAllMocks()
		currentApiConfigName = "opus"
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValue("common:answers.yes" as any)
		provider = {
			getCurrentTask: vi.fn(() => undefined),
			postMessageToWebview: vi.fn(),
			log: vi.fn(),
			contextProxy: {
				getValue: vi.fn((key: string) => (key === "currentApiConfigName" ? currentApiConfigName : undefined)),
				setValue: vi.fn(),
				globalStorageUri: { fsPath: "/test" },
			},
			providerSettingsManager: {
				listConfig: vi.fn(async () => [
					{ name: "deepseek", id: "d" },
					{ name: "opus", id: "o" },
					{ name: "opus-reject", id: "r" },
				]),
				deleteConfig: vi.fn(async () => {}),
			},
			activateProviderProfile: vi.fn(async () => {}),
		}
	})

	it("keeps the current global profile when a non-current profile is deleted", async () => {
		await webviewMessageHandler(provider, { type: "deleteApiConfiguration", text: "opus-reject" })
		expect(provider.providerSettingsManager.deleteConfig).toHaveBeenCalledWith("opus-reject")
		expect(provider.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "opus" },
			{ explicitTaskSelection: true, keepFinishedTaskProfile: true },
		)
	})

	it("activates the first remaining profile when the current profile is deleted", async () => {
		currentApiConfigName = "opus-reject"
		await webviewMessageHandler(provider, { type: "deleteApiConfiguration", text: "opus-reject" })
		expect(provider.activateProviderProfile).toHaveBeenCalledWith(
			{ name: "deepseek" },
			{ explicitTaskSelection: true, keepFinishedTaskProfile: true },
		)
	})

	it("does not delete when the user cancels", async () => {
		vi.mocked(vscode.window.showInformationMessage).mockResolvedValue(undefined as any)
		await webviewMessageHandler(provider, { type: "deleteApiConfiguration", text: "opus-reject" })
		expect(provider.providerSettingsManager.deleteConfig).not.toHaveBeenCalled()
		expect(provider.activateProviderProfile).not.toHaveBeenCalled()
	})

	it("loads a profile by ID as a global change that keeps a finished task's profile", async () => {
		await webviewMessageHandler(provider, { type: "loadApiConfigurationById", text: "o" })
		expect(provider.activateProviderProfile).toHaveBeenCalledWith(
			{ id: "o" },
			{ explicitTaskSelection: true, keepFinishedTaskProfile: true },
		)
	})
})
