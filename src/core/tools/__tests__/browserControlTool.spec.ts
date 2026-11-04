import * as vscode from "vscode"
import { browserControlTool } from "../browserControlTool"
import { validateToolUse } from "../validateToolUse"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"

vi.mock("../validateToolUse", () => ({ validateToolUse: vi.fn() }))
vi.mock("vscode", () => ({ window: { showWarningMessage: vi.fn() } }))

function fixture() {
	let state = {
		sessionId: "session",
		generation: 0,
		tabId: "tab",
		capabilities: {
			status: true,
			navigate: true,
			tabs: true,
			snapshot: true,
			performance: true,
			click_ref: true,
			fill_ref: true,
			select_ref: true,
			select_tab: true,
		},
		extensionHost: { hostname: "test", platform: "linux" },
	}
	const provider = {
		getCurrentTask: vi.fn(() => task),
		getState: vi.fn(async () => ({
			mode: "code",
			disabledTools: [],
			autoApprovalEnabled: false,
			alwaysAllowBrowser: false,
		})),
		isTaskBackgrounded: false,
	}
	const task = {
		providerRef: { deref: (): unknown => provider },
		modelOperationState: { revision: 1 },
		abort: false,
		checkToolInvocation: vi.fn(async () => ({ allow: true })),
		say: vi.fn(async () => {}),
		browserSession: {
			getControlState: vi.fn(() => state),
			control: vi.fn(async (command) => ({ ok: true, action: command.action, state, warnings: [], data: {} })),
		},
	}
	const run = (command: unknown = { action: "status" }) =>
		browserControlTool(
			task as unknown as Task,
			{
				type: "tool_use",
				name: "browser_action",
				params: { action: "control", command: JSON.stringify(command) },
				partial: false,
			} as ToolUse,
			push,
		)
	const push = vi.fn()
	return {
		task,
		provider,
		run,
		push,
		changeSession: () => {
			state = { ...state, sessionId: "replacement" }
		},
	}
}

describe("rich browser approval", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(validateToolUse).mockReset()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
	})
	it.each([
		{ action: "status", approved: true },
		{ action: "evaluate", sessionId: "s", tabId: "t", expression: "1" },
		{ action: "fill_ref" },
	])("rejects invalid/unsupported controls before approval", async (command) => {
		const f = fixture()
		await expect(f.run(command)).rejects.toThrow()
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("refuses an unavailable active-transport capability before review", async () => {
		const f = fixture()
		f.task.browserSession.getControlState().capabilities.snapshot = false
		await expect(f.run({ action: "snapshot", sessionId: "session", tabId: "tab" })).rejects.toThrow("unavailable")
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("denies even status without a native affirmative answer", async () => {
		const f = fixture()
		await f.run()
		expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
		expect(f.push).toHaveBeenCalledWith(expect.stringContaining("denied"))
	})
	it.each(["session", "task", "abort", "revision", "background"])(
		"rejects %s changes during review without browser calls",
		async (change) => {
			const f = fixture()
			vi.mocked(vscode.window.showWarningMessage).mockImplementationOnce(async () => {
				if (change === "session") f.changeSession()
				if (change === "task") f.provider.getCurrentTask.mockReturnValue({} as typeof f.task)
				if (change === "abort") f.task.abort = true
				if (change === "revision") f.task.modelOperationState.revision++
				if (change === "background") f.provider.isTaskBackgrounded = true
				return "Approve this command" as any
			})
			await expect(f.run()).rejects.toThrow()
			expect(f.task.browserSession.control).not.toHaveBeenCalled()
		},
	)
	it("rechecks the mode after review", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		vi.mocked(validateToolUse)
			.mockImplementationOnce(() => {})
			.mockImplementationOnce(() => {
				throw new Error("denied mode")
			})
		await expect(f.run()).rejects.toThrow("denied mode")
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("executes once and discloses transcript persistence", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		await f.run({ action: "tabs" })
		expect(f.task.browserSession.control).toHaveBeenCalledExactlyOnceWith({ action: "tabs" })
		expect(f.push).toHaveBeenCalledWith(expect.stringContaining("enter task history and model context"))
	})
	it("reuses one read-only approval per task and session", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		await f.run({ action: "tabs" })
		await f.run({ action: "snapshot", sessionId: "session", tabId: "tab" })
		await f.run({ action: "performance", sessionId: "session", tabId: "tab" })
		expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
		expect(f.task.browserSession.control).toHaveBeenCalledTimes(3)
	})
	it("requires a fresh read-only approval after the browser session changes", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		await f.run({ action: "tabs" })
		f.changeSession()
		await f.run({ action: "tabs" })
		expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
	})
	it.each([
		{ action: "navigate", url: "https://example.org" },
		{ action: "click_ref", sessionId: "session", tabId: "tab", ref: "ref" },
		{ action: "fill_ref", sessionId: "session", tabId: "tab", ref: "ref", text: "x" },
		{ action: "select_ref", sessionId: "session", tabId: "tab", ref: "ref", values: ["a"] },
		{ action: "select_tab", sessionId: "session", tabId: "tab" },
	])("always requires explicit approval for %s", async (command) => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		await f.run({ action: "tabs" })
		await f.run(command)
		await f.run(command)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(3)
	})
	it("skips the modal for every command when browser auto-approval is enabled", async () => {
		const f = fixture()
		f.provider.getState.mockResolvedValue({
			mode: "code",
			disabledTools: [],
			autoApprovalEnabled: true,
			alwaysAllowBrowser: true,
		} as never)
		for (const command of [
			{ action: "tabs" },
			{ action: "navigate", url: "https://example.org" },
			{ action: "click_ref", sessionId: "session", tabId: "tab", ref: "ref" },
			{ action: "select_tab", sessionId: "session", tabId: "tab" },
		])
			await f.run(command)
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.task.browserSession.control).toHaveBeenCalledTimes(4)
	})
	it("still prompts when auto-approval is enabled but the browser toggle is off", async () => {
		const f = fixture()
		f.provider.getState.mockResolvedValue({
			mode: "code",
			disabledTools: [],
			autoApprovalEnabled: true,
			alwaysAllowBrowser: false,
		} as never)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		await f.run({ action: "tabs" })
		expect(vscode.window.showWarningMessage).toHaveBeenCalledOnce()
	})
	it("keeps capability and session fences under browser auto-approval", async () => {
		const f = fixture()
		f.provider.getState.mockResolvedValue({
			mode: "code",
			disabledTools: [],
			autoApprovalEnabled: true,
			alwaysAllowBrowser: true,
		} as never)
		await expect(
			f.run({ action: "evaluate", sessionId: "session", tabId: "tab", expression: "1" }),
		).rejects.toThrow()
		await expect(f.run({ action: "snapshot", sessionId: "stale", tabId: "tab" })).rejects.toThrow("stale session")
		expect(f.task.browserSession.control).not.toHaveBeenCalled()
	})
	it("discards a result if the session changes during transcript persistence", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Approve this command" as any)
		f.task.say.mockImplementationOnce(async () => {
			f.changeSession()
		})
		await expect(f.run()).rejects.toThrow("session changed")
		expect(f.task.say).toHaveBeenCalledOnce()
		expect(f.push).not.toHaveBeenCalled()
	})
})
