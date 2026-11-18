const showInformationMessage = vi.fn()
vi.mock("vscode", () => ({
	window: { showInformationMessage: (...a: unknown[]) => showInformationMessage(...a), createStatusBarItem: vi.fn() },
	commands: { registerCommand: vi.fn() },
	StatusBarAlignment: { Left: 1 },
	ThemeColor: class {},
}))

vi.mock("../../core/webview/ClineProvider", () => ({ ClineProvider: { getActiveInstances: () => [] } }))
vi.mock("../../core/config/ContextProxy", () => ({ ContextProxy: {} }))
vi.mock("../../services/code-index/manager", () => ({ CodeIndexManager: {} }))
vi.mock("../../core/config/importExport", () => ({ importSettingsWithFeedback: vi.fn() }))
vi.mock("../../i18n", () => ({ t: (k: string) => k }))

const reset = vi.fn()
vi.mock("../../services/desktop/activityIndicator", () => ({ getDesktopActivityIndicator: () => ({ reset }) }))

import { stopComputerUse } from "../registerCommands"
import { getDesktopSession, hasDesktopSession, setDesktopSessionFactory } from "../../services/desktop/sessionRegistry"

const outputChannel = { appendLine: vi.fn() } as never

function provider(task: object | undefined) {
	return { getCurrentTask: () => task, cancelTask: vi.fn(async () => {}) }
}

describe("stopComputerUse", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		setDesktopSessionFactory(() => ({}) as never)
	})
	afterEach(() => setDesktopSessionFactory(undefined))

	it("cancels only tasks that have a desktop session, in every provider, and releases the sessions", async () => {
		const desktopTask = { taskId: "a" }
		const otherTask = { taskId: "b" }
		getDesktopSession(desktopTask, "/ext")

		const p1 = provider(desktopTask)
		const p2 = provider(otherTask)
		const p3 = provider(undefined)

		const cancelled = await stopComputerUse(outputChannel, [p1, p2, p3] as never)

		expect(cancelled).toBe(1)
		expect(p1.cancelTask).toHaveBeenCalledOnce()
		expect(p2.cancelTask).not.toHaveBeenCalled()
		expect(hasDesktopSession(desktopTask)).toBe(false)
		expect(reset).toHaveBeenCalled()
		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringMatching(/cancelled 1 task\./))
	})

	it("reports when nothing is running", async () => {
		const cancelled = await stopComputerUse(outputChannel, [provider({ taskId: "x" })] as never)
		expect(cancelled).toBe(0)
		expect(showInformationMessage).toHaveBeenCalledWith("Roo is not controlling the desktop.")
	})

	it("continues with other providers when one cancel fails", async () => {
		const t1 = { taskId: "1" }
		const t2 = { taskId: "2" }
		getDesktopSession(t1, "/ext")
		getDesktopSession(t2, "/ext")
		const p1 = provider(t1)
		p1.cancelTask.mockRejectedValueOnce(new Error("boom"))
		const p2 = provider(t2)

		const cancelled = await stopComputerUse(outputChannel, [p1, p2] as never)

		expect(cancelled).toBe(1)
		expect(p2.cancelTask).toHaveBeenCalledOnce()
		expect(hasDesktopSession(t1)).toBe(false)
	})
})
