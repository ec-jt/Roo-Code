import * as vscode from "vscode"
import { handleBrowserControlRequest } from "../browserControlMessageHandler"
import type { ClineProvider } from "../ClineProvider"
import type { ExtensionMessage } from "@roo-code/types"

vi.mock("../../tools/validateToolUse", () => ({ validateToolUse: vi.fn() }))
vi.mock("vscode", () => ({ window: { showWarningMessage: vi.fn(), showInputBox: vi.fn() } }))

function fixture() {
	let state = {
		sessionId: "session",
		generation: 0,
		connected: true,
		ownership: "roo-owned",
		transport: "cdp",
		extensionHost: { hostname: "test", platform: "linux" },
	}
	const provider = {
		getCurrentTask: vi.fn(() => task),
		getState: vi.fn(async () => ({ mode: "code" })),
		postMessageToWebview: vi.fn((_message: ExtensionMessage) => {}),
		isTaskBackgrounded: false,
	}
	const task = {
		taskId: "task",
		instanceId: "instance",
		modelOperationState: { revision: 1 },
		providerRef: { deref: (): unknown => provider },
		assertTaskStateNativeAllowed: vi.fn(),
		browserSession: {
			getControlState: vi.fn(() => state),
			closeBrowser: vi.fn(),
			launchIsolatedCertificateSession: vi.fn(async (authorize: () => Promise<void>) => {
				await authorize()
				state = { ...state, sessionId: "isolated", connected: true, ownership: "roo-owned" }
			}),
			startExtensionBridge: vi.fn(async () => {
				state = { ...state, sessionId: "bridge", connected: false, transport: "chrome-extension" }
				return { endpoint: "http://127.0.0.1:1234", secret: "PRIVATE_PAIRING_CREDENTIAL" }
			}),
			control: vi.fn(async () => ({
				ok: true,
				state,
				data: { tabs: [{ id: "tab", url: "https://user:secret@example.test/path?token=secret#secret" }] },
			})),
		},
	}
	const request = {
		taskId: "task",
		instanceId: "instance",
		sessionId: "session",
		requestId: "request",
		action: "tabs",
	}
	const run = (raw: unknown = request) => handleBrowserControlRequest(provider as unknown as ClineProvider, raw)
	return {
		task,
		provider,
		request,
		run,
		disconnect: () => {
			state = { ...state, connected: false, ownership: "none" }
		},
		changeSession: () => {
			state = { ...state, sessionId: "new" }
		},
	}
}
describe("native browser session protocol", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
	})
	it("refreshes local metadata without accessing the browser", async () => {
		const f = fixture()
		await f.run({ taskId: "task", requestId: "request", action: "refresh" })
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
		expect(f.provider.postMessageToWebview).toHaveBeenCalledWith(
			expect.objectContaining({
				browserControlResponse: expect.objectContaining({ instanceId: "instance", state: expect.any(Object) }),
			}),
		)
	})
	it.each(["tabs", "select", "disconnect", "start_bridge", "stop_bridge"])(
		"cancels %s with zero browser calls",
		async (action) => {
			const f = fixture()
			await f.run({ ...f.request, action, ...(action === "select" ? { tabId: "tab" } : {}) })
			expect(f.task.browserSession.control).not.toHaveBeenCalled()
			expect(f.task.browserSession.closeBrowser).not.toHaveBeenCalled()
			expect(f.task.browserSession.startExtensionBridge).not.toHaveBeenCalled()
			expect(f.provider.postMessageToWebview).toHaveBeenCalledWith(
				expect.objectContaining({ browserControlResponse: expect.objectContaining({ cancelled: true }) }),
			)
		},
	)
	it("pairs using native inputs only and sends no credentials to the panel", async () => {
		const f = fixture()
		f.disconnect()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve session action" as any)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("a".repeat(32)).mockResolvedValueOnce("")
		await f.run({ ...f.request, action: "start_bridge" })
		expect(f.task.browserSession.startExtensionBridge).toHaveBeenCalledWith("a".repeat(32))
		expect(vscode.window.showInputBox).toHaveBeenLastCalledWith(
			expect.objectContaining({ value: "PRIVATE_PAIRING_CREDENTIAL" }),
		)
		expect(JSON.stringify(f.provider.postMessageToWebview.mock.calls)).not.toContain("PRIVATE_PAIRING_CREDENTIAL")
		expect(JSON.stringify(f.provider.postMessageToWebview.mock.calls)).not.toContain("127.0.0.1")
	})
	it("rejects a stale task after the extension-ID input and before listening", async () => {
		const f = fixture()
		f.disconnect()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve session action" as any)
		vi.mocked(vscode.window.showInputBox).mockImplementationOnce(async () => {
			f.task.modelOperationState.revision++
			return "a".repeat(32)
		})
		await f.run({ ...f.request, action: "start_bridge" })
		expect(f.task.browserSession.startExtensionBridge).not.toHaveBeenCalled()
	})
	it("revokes a started listener when native pairing is cancelled", async () => {
		const f = fixture()
		f.disconnect()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve session action" as any)
		vi.mocked(vscode.window.showInputBox).mockResolvedValueOnce("a".repeat(32)).mockResolvedValueOnce(undefined)
		await f.run({ ...f.request, action: "start_bridge" })
		expect(f.task.browserSession.closeBrowser).toHaveBeenCalledOnce()
	})
	it("requires a separate broad-scope certificate confirmation and respects denial", async () => {
		const f = fixture()
		f.disconnect()
		vi.mocked(vscode.window.showWarningMessage)
			.mockResolvedValueOnce("Approve session action" as any)
			.mockResolvedValueOnce(undefined)
		await f.run({ ...f.request, action: "start_certificate_session" })
		expect(f.task.browserSession.launchIsolatedCertificateSession).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.objectContaining({ detail: expect.stringContaining("ALL invalid TLS certificates") }),
			"Launch isolated exception session",
		)
	})
	it("launches only after native certificate review and rechecks stale authorization", async () => {
		const f = fixture()
		f.disconnect()
		vi.mocked(vscode.window.showWarningMessage)
			.mockResolvedValueOnce("Approve session action" as any)
			.mockResolvedValueOnce("Launch isolated exception session" as any)
		await f.run({ ...f.request, action: "start_certificate_session" })
		expect(f.task.browserSession.launchIsolatedCertificateSession).toHaveBeenCalledOnce()
		const stale = fixture()
		stale.disconnect()
		vi.mocked(vscode.window.showWarningMessage)
			.mockResolvedValueOnce("Approve session action" as any)
			.mockImplementationOnce(async () => {
				stale.task.modelOperationState.revision++
				return "Launch isolated exception session" as any
			})
		await stale.run({ ...stale.request, action: "start_certificate_session" })
		expect(stale.task.browserSession.launchIsolatedCertificateSession).not.toHaveBeenCalled()
	})
	it("rejects certificate exceptions on an existing session", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve session action" as any)
		await f.run({ ...f.request, action: "start_certificate_session" })
		expect(f.task.browserSession.launchIsolatedCertificateSession).not.toHaveBeenCalled()
	})
	it("rejects arbitrary commands before native review", async () => {
		const f = fixture()
		await f.run({ ...f.request, command: { action: "evaluate" } })
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it.each(["session", "instance", "task", "background", "busy"])("rejects stale or disallowed %s", async (change) => {
		const f = fixture()
		if (change === "session") f.changeSession()
		if (change === "instance") f.request.instanceId = "old"
		if (change === "task") f.request.taskId = "old"
		if (change === "background") f.provider.isTaskBackgrounded = true
		if (change === "busy")
			f.task.assertTaskStateNativeAllowed.mockImplementation(() => {
				throw new Error("busy")
			})
		await f.run()
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("rechecks session after modal await", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
			f.changeSession()
			return "Approve session action" as any
		})
		await f.run()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("returns correlated sanitized tabs after approval", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve session action" as any)
		await f.run()
		expect(f.task.browserSession.control).toHaveBeenCalledExactlyOnceWith({ action: "tabs" })
		const reply = f.provider.postMessageToWebview.mock.calls[0][0].browserControlResponse!
		expect(reply).toMatchObject({
			requestId: "request",
			taskId: "task",
			instanceId: "instance",
			requestedSessionId: "session",
		})
		expect(reply.tabs![0].url).toBe("https://example.test/path")
	})
})
