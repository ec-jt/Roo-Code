// npx vitest run core/webview/__tests__/webviewMessageHandler.computerUse.spec.ts

vi.mock("vscode", () => ({
	env: { remoteName: "ssh-remote" },
	window: { showInformationMessage: vi.fn(), showErrorMessage: vi.fn(), showWarningMessage: vi.fn() },
	workspace: { workspaceFolders: [], getConfiguration: () => ({ get: vi.fn(), update: vi.fn() }) },
	Uri: { file: (p: string) => ({ fsPath: p }) },
	ConfigurationTarget: { Global: 1 },
}))

const checkPlatform = vi.fn()
vi.mock("../../../services/desktop/platformCheck", () => ({
	checkPlatform: (...args: unknown[]) => checkPlatform(...args),
}))

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { ClineProvider } from "../ClineProvider"

describe("webviewMessageHandler - checkComputerUsePermissions", () => {
	let provider: { context: { extensionPath: string }; postMessageToWebview: ReturnType<typeof vi.fn> }

	beforeEach(() => {
		vi.clearAllMocks()
		provider = { context: { extensionPath: "/ext" }, postMessageToWebview: vi.fn() }
	})

	const run = () =>
		webviewMessageHandler(provider as unknown as ClineProvider, { type: "checkComputerUsePermissions" } as never)

	it("runs the platform check with prompts enabled (user-initiated) and the real remoteName and extensionPath", async () => {
		checkPlatform.mockReturnValue({ ok: true, warnings: [] })
		await run()
		expect(checkPlatform).toHaveBeenCalledWith({
			remoteName: "ssh-remote",
			extensionPath: "/ext",
			requestMissingPermissions: true,
		})
	})

	it("posts success with warnings", async () => {
		checkPlatform.mockReturnValue({ ok: true, warnings: ["XWayland note"] })
		await run()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "computerUsePermissionsResult",
			success: true,
			text: "",
			values: { warnings: ["XWayland note"], remedy: [] },
		})
	})

	it("posts failure with code, remedy steps, and missing permissions", async () => {
		checkPlatform.mockReturnValue({
			ok: false,
			code: "macos_permissions_missing",
			message: "Needs permissions",
			remedy: ["Open System Settings"],
			missingPermissions: ["screen"],
		})
		await run()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "computerUsePermissionsResult",
			success: false,
			text: "Needs permissions",
			values: {
				code: "macos_permissions_missing",
				remedy: ["Open System Settings"],
				missingPermissions: ["screen"],
				warnings: [],
			},
		})
	})

	it("reports a thrown error instead of crashing", async () => {
		checkPlatform.mockImplementation(() => {
			throw new Error("native load failed")
		})
		await run()
		expect(provider.postMessageToWebview).toHaveBeenCalledWith({
			type: "computerUsePermissionsResult",
			success: false,
			text: "native load failed",
			values: { remedy: [], warnings: [] },
		})
	})
})
