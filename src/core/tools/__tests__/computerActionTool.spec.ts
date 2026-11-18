import { ComputerActionTool } from "../ComputerActionTool"
import { setDesktopSessionFactory, releaseDesktopSession } from "../../../services/desktop/sessionRegistry"
import { ComputerActionError } from "../../../services/desktop/DesktopSession"

vi.mock("vscode", () => ({ env: { remoteName: undefined } }))

const endActivity = vi.fn()
const beginActivity = vi.fn((_label?: string) => endActivity)
vi.mock("../../../services/desktop/activityIndicator", () => ({
	getDesktopActivityIndicator: () => ({ begin: beginActivity }),
}))

const checkPlatform = vi.fn()
vi.mock("../../../services/desktop/platformCheck", () => ({
	checkPlatform: (...args: unknown[]) => checkPlatform(...args),
	formatPlatformCheckFailure: (r: { message: string }) => `FORMATTED: ${r.message}`,
}))

const SHOT = "data:image/png;base64,AAAA"

function createSession(overrides: Record<string, unknown> = {}) {
	return {
		execute: vi.fn(async () => ({
			screenshot: SHOT,
			screenshotWidth: 1232,
			screenshotHeight: 800,
			cursorPosition: "10,20",
			activeWindowTitle: "Notes",
			executedCoordinate: "20,40",
		})),
		getActiveWindowTitle: vi.fn(() => "Notes"),
		findWindow: vi.fn((q: string) => ({ id: 7, title: q === "7" ? "Safari" : "Notes" })),
		...overrides,
	}
}

function createTask(state: Record<string, unknown> = {}, supportsImages = true) {
	return {
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
		say: vi.fn(async () => undefined),
		ask: vi.fn(async () => undefined),
		sayAndCreateMissingParamError: vi.fn(async (_tool: string, param: string) => `missing ${param}`),
		api: { getModel: () => ({ info: { supportsImages } }) },
		providerRef: {
			deref: () => ({
				getState: async () => ({ computerUseEnabled: true, ...state }),
				context: { extensionPath: "/ext" },
			}),
		},
	}
}

function createCallbacks(approve = true) {
	return {
		askApproval: vi.fn(async () => approve),
		handleError: vi.fn(async () => {}),
		pushToolResult: vi.fn(),
	}
}

describe("ComputerActionTool", () => {
	let session: ReturnType<typeof createSession>
	let task: ReturnType<typeof createTask>

	beforeEach(() => {
		checkPlatform.mockReset().mockReturnValue({ ok: true, warnings: [] })
		session = createSession()
		setDesktopSessionFactory(() => session as never)
	})

	afterEach(() => {
		if (task) releaseDesktopSession(task)
		setDesktopSessionFactory(undefined)
	})

	async function run(
		params: Record<string, unknown>,
		opts: { state?: Record<string, unknown>; approve?: boolean; supportsImages?: boolean } = {},
	) {
		task = createTask(opts.state, opts.supportsImages ?? true)
		const callbacks = createCallbacks(opts.approve ?? true)
		await new ComputerActionTool().execute(params as never, task as never, callbacks)
		return { task, callbacks }
	}

	it("returns a missing-param error when action is absent", async () => {
		const { callbacks, task } = await run({})
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("computer_action", "action")
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it.each([
		[{ action: "click" }, "coordinate"],
		[{ action: "drag", coordinate: "1,1" }, "end_coordinate"],
		[{ action: "type" }, "text"],
		[{ action: "key" }, "key"],
		[{ action: "focus_window" }, "window"],
	])("validates required params before approval: %j", async (params, missing) => {
		const { callbacks, task } = await run(params)
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith("computer_action", missing)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(session.execute).not.toHaveBeenCalled()
	})

	it("treats null optional params as absent", async () => {
		const { callbacks } = await run({ action: "screenshot", coordinate: null, text: null })
		expect(session.execute).toHaveBeenCalledWith({ action: "screenshot" })
		expect(callbacks.askApproval).toHaveBeenCalled()
	})

	it("refuses when the feature is disabled", async () => {
		const { callbacks } = await run({ action: "screenshot" }, { state: { computerUseEnabled: false } })
		expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/turned off/)
		expect(checkPlatform).not.toHaveBeenCalled()
		expect(session.execute).not.toHaveBeenCalled()
	})

	describe("background mode", () => {
		const realPlatform = process.platform
		const setPlatform = (p: string) => Object.defineProperty(process, "platform", { value: p })
		afterEach(() => setPlatform(realPlatform))

		it.each(["click", "type", "key", "scroll", "move", "drag", "focus_window"])(
			"refuses %s, which uses the shared pointer or keyboard",
			async (action) => {
				setPlatform("darwin")
				const { callbacks } = await run(
					{ action, coordinate: "1,1", end_coordinate: "2,2", text: "x", key: "a", window: "w" },
					{ state: { computerUseBackgroundMode: true } },
				)
				expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/not available in background mode/)
				expect(callbacks.askApproval).not.toHaveBeenCalled()
				expect(session.execute).not.toHaveBeenCalled()
			},
		)

		it.each([
			{ action: "screenshot" },
			{ action: "list_windows" },
			{ action: "list_elements", window: "Notes" },
			{ action: "click_element", window: "Notes", element: "Save" },
			{ action: "window_type", window: "Notes", text: "hi" },
			{ action: "window_screenshot", window: "Notes" },
		])("allows %j", async (params) => {
			setPlatform("darwin")
			const { callbacks } = await run(params, { state: { computerUseBackgroundMode: true } })
			expect(callbacks.askApproval).toHaveBeenCalled()
			expect(session.execute).toHaveBeenCalled()
		})

		it("refuses everything outside macOS and says how to turn it off", async () => {
			setPlatform("win32")
			const { callbacks } = await run({ action: "screenshot" }, { state: { computerUseBackgroundMode: true } })
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/only available on macOS/)
			expect(session.execute).not.toHaveBeenCalled()
		})
	})

	it("refuses with formatted remedy steps when the platform check fails", async () => {
		checkPlatform.mockReturnValue({ ok: false, code: "linux_wayland_only", message: "Wayland only", remedy: [] })
		const { callbacks, task } = await run({ action: "screenshot" })
		expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/FORMATTED: Wayland only/)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
	})

	it("passes the extension path to the platform check", async () => {
		await run({ action: "screenshot" })
		expect(checkPlatform).toHaveBeenCalledWith({ remoteName: undefined, extensionPath: "/ext" })
	})

	it("asks for approval with the computer_action ask type and the action payload", async () => {
		const { callbacks } = await run({ action: "click", coordinate: "10,20" })
		expect(callbacks.askApproval).toHaveBeenCalledWith("computer_action", expect.any(String))
		const payload = JSON.parse((callbacks.askApproval.mock.calls[0] as unknown[])[1] as string)
		expect(payload).toMatchObject({ action: "click", coordinate: "10,20" })
	})

	it("does nothing when the user denies approval", async () => {
		const { callbacks } = await run({ action: "click", coordinate: "10,20" }, { approve: false })
		expect(session.execute).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("returns the screenshot image followed by a text summary", async () => {
		const { callbacks, task } = await run({ action: "click", coordinate: "10,20" })
		const result = callbacks.pushToolResult.mock.calls[0][0]
		expect(result[0]).toMatchObject({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "AAAA" },
		})
		expect(result[1].text).toMatch(/Action "click" executed/)
		expect(result[1].text).toMatch(/Screenshot size: 1232x800/)
		expect(result[1].text).toMatch(/Active window: "Notes"/)
		expect(task.say).toHaveBeenCalledWith(
			"computer_action",
			expect.stringContaining('"executedCoordinate":"20,40"'),
			undefined,
			false,
		)
		expect(task.say).toHaveBeenCalledWith("computer_action_result", expect.any(String))
	})

	it("omits the image and says why when the model has no vision support", async () => {
		const { callbacks } = await run({ action: "screenshot" }, { supportsImages: false })
		const result = callbacks.pushToolResult.mock.calls[0][0]
		expect(typeof result).toBe("string")
		expect(result).toMatch(/does not accept images/)
	})

	it("formats list_windows as text", async () => {
		session.execute.mockResolvedValueOnce({
			windows: [{ id: 3, title: "Notes", x: 0, y: 0, width: 800, height: 600, active: true }],
		} as never)
		const { callbacks } = await run({ action: "list_windows" })
		expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/id 3 \(active\): "Notes" at 0,0 size 800x600/)
	})

	describe("app allowlist", () => {
		it("blocks state-changing actions when the active window is not allowed", async () => {
			const { callbacks } = await run(
				{ action: "type", text: "hi" },
				{ state: { computerUseAllowedApps: ["Safari"] } },
			)
			// toolError JSON-encodes the message, so match text without quotes.
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(
				/Notes.{0,4} is not in the Computer Use app allowlist \(Safari\)/,
			)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		})

		it("allows state-changing actions when the active window matches", async () => {
			const { callbacks } = await run(
				{ action: "type", text: "hi" },
				{ state: { computerUseAllowedApps: ["notes"] } },
			)
			expect(callbacks.askApproval).toHaveBeenCalled()
		})

		it("always allows read-only actions", async () => {
			const { callbacks } = await run({ action: "screenshot" }, { state: { computerUseAllowedApps: ["Safari"] } })
			expect(callbacks.askApproval).toHaveBeenCalled()
		})

		it("checks the target window, not the active one, for focus_window", async () => {
			const { callbacks } = await run(
				{ action: "focus_window", window: "7" },
				{ state: { computerUseAllowedApps: ["Safari"] } },
			)
			expect(session.findWindow).toHaveBeenCalledWith("7")
			expect(callbacks.askApproval).toHaveBeenCalled()
		})
	})

	it("reports ComputerActionError as a tool error, not via handleError", async () => {
		session.execute.mockRejectedValueOnce(new ComputerActionError("outside the screenshot"))
		const { callbacks, task } = await run({ action: "click", coordinate: "9999,1" })
		expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/outside the screenshot/)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(1)
	})

	it("shows the status bar indicator while the action runs and ends it afterwards", async () => {
		await run({ action: "click", coordinate: "1,1" })
		expect(beginActivity).toHaveBeenCalledWith("click")
		expect(endActivity).toHaveBeenCalled()
	})

	it("ends the indicator even when the action throws", async () => {
		endActivity.mockClear()
		session.execute.mockRejectedValueOnce(new Error("native crash"))
		await run({ action: "click", coordinate: "1,1" })
		expect(endActivity).toHaveBeenCalledOnce()
	})

	it("does not execute if the task was aborted while the approval prompt was open", async () => {
		task = createTask()
		const callbacks = createCallbacks(true)
		callbacks.askApproval.mockImplementation(async () => {
			;(task as { abort?: boolean }).abort = true
			return true
		})
		await new ComputerActionTool().execute(
			{ action: "click", coordinate: "1,1" } as never,
			task as never,
			callbacks,
		)
		expect(session.execute).not.toHaveBeenCalled()
	})

	it("sends unexpected errors to handleError", async () => {
		session.execute.mockRejectedValueOnce(new Error("native crash"))
		const { callbacks } = await run({ action: "screenshot" })
		expect(callbacks.handleError).toHaveBeenCalledWith("executing computer action", expect.any(Error))
	})
})
