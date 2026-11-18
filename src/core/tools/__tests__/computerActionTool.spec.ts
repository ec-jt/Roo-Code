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
		executeBatch: vi.fn(
			async (
				steps: Array<Record<string, unknown>>,
				_opts?: Record<string, unknown>,
			): Promise<Record<string, unknown>> => ({
				screenshot: SHOT,
				screenshotWidth: 1232,
				screenshotHeight: 800,
				activeWindowTitle: "Notes",
				completed: steps.map((params, i) => ({
					params,
					executedCoordinate: params.coordinate ? `${i},${i}` : undefined,
				})),
			}),
		),
		execute: vi.fn(async (_params?: unknown, _opts?: unknown) => ({
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

	describe("submit and screenshot: false", () => {
		it("passes submit to the session as a boolean and shows it in the approval", async () => {
			const { callbacks } = await run({ action: "type", text: "hi", submit: "true" })
			expect(session.execute).toHaveBeenCalledWith({ action: "type", text: "hi", submit: true })
			const payload = JSON.parse((callbacks.askApproval.mock.calls[0] as unknown[])[1] as string)
			expect(payload).toMatchObject({ action: "type", text: "hi", submit: true })
		})

		it("rejects submit on window_type before approval", async () => {
			const { callbacks } = await run({ action: "window_type", window: "Notes", text: "hi", submit: true })
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/submit is not available for window_type/)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		})

		it("returns text only when screenshot is false", async () => {
			session.execute.mockResolvedValueOnce({ activeWindowTitle: "Notes", executedCoordinate: "20,40" } as never)
			const { callbacks } = await run({ action: "click", coordinate: "10,20", screenshot: false })
			expect(session.execute).toHaveBeenCalledWith(
				{ action: "click", coordinate: "10,20" },
				{ screenshot: false },
			)
			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(typeof result).toBe("string")
			expect(result).toMatch(/No screenshot was taken/)
		})

		it.each(["screenshot", "list_windows"])("rejects screenshot: false on read-only %s", async (action) => {
			const { callbacks } = await run({ action, screenshot: false })
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/only for actions that change something/)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		})
	})

	describe("batched actions", () => {
		const batch = [
			{ action: "focus_window", window: "Notes" },
			{ action: "click", coordinate: "10,20" },
			{ action: "type", text: "hello", submit: true },
		]

		it("asks once for the whole batch, listing every step", async () => {
			const { callbacks } = await run({ actions: batch })
			expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
			const payload = JSON.parse((callbacks.askApproval.mock.calls[0] as unknown[])[1] as string)
			expect(payload.action).toBeUndefined()
			expect(payload.steps).toEqual([
				expect.objectContaining({ action: "focus_window", window: "Notes" }),
				expect.objectContaining({ action: "click", coordinate: "10,20" }),
				expect.objectContaining({ action: "type", text: "hello", submit: true }),
			])
			expect(session.executeBatch).toHaveBeenCalledTimes(1)
			expect(session.execute).not.toHaveBeenCalled()
		})

		it("accepts actions as a JSON string", async () => {
			const { callbacks } = await run({ actions: JSON.stringify(batch) })
			expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
			expect(session.executeBatch.mock.calls[0][0]).toHaveLength(3)
		})

		it("returns one screenshot and lists the steps that ran with executed coordinates", async () => {
			const { callbacks, task } = await run({ actions: batch })
			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result.filter((b: { type: string }) => b.type === "image")).toHaveLength(1)
			const text = result[result.length - 1].text
			expect(text).toMatch(/Batch of 3 steps executed/)
			expect(text).toMatch(/1\. focus_window window "Notes"/)
			expect(text).toMatch(/2\. click 10,20 \(screen 1,1\)/)
			expect(text).toMatch(/3\. type "hello" \+ Enter/)
			const say = (task.say.mock.calls as unknown[][]).find((c) => c[0] === "computer_action")
			expect(JSON.parse(say![1] as string).steps).toHaveLength(3)
		})

		it("passes screenshot: false to the batch and returns text only", async () => {
			session.executeBatch.mockImplementationOnce(async (steps) => ({
				completed: steps.map((params) => ({ params })),
				activeWindowTitle: "Notes",
			}))
			const { callbacks } = await run({ actions: batch, screenshot: false })
			expect(session.executeBatch.mock.calls[0][1]).toMatchObject({ screenshot: false })
			expect(typeof callbacks.pushToolResult.mock.calls[0][0]).toBe("string")
		})

		it.each([
			[
				"too many steps",
				{ actions: Array.from({ length: 11 }, () => ({ action: "key", key: "a" })) },
				/1 to 10 steps/,
			],
			["no steps", { actions: [] }, /1 to 10 steps/],
			["a read-only step", { actions: [{ action: "screenshot" }] }, /cannot be a batch step/],
			[
				"a missing parameter",
				{ actions: [{ action: "key", key: "a" }, { action: "click" }] },
				/Step 2 \(click\) is missing the required parameter .{0,2}coordinate/,
			],
			[
				"both action and actions",
				{ action: "click", coordinate: "1,1", actions: [{ action: "key", key: "a" }] },
				/not both/,
			],
			[
				"submit on window_type",
				{ actions: [{ action: "window_type", window: "Notes", text: "x", submit: true }] },
				/submit is not available/,
			],
		])("rejects %s before approval", async (_name, params, message) => {
			const { callbacks } = await run(params)
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(message)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(session.executeBatch).not.toHaveBeenCalled()
		})

		it("rejects a step whose window is not in the allowlist before approval", async () => {
			const { callbacks } = await run(
				{
					actions: [
						{ action: "focus_window", window: "7" },
						{ action: "click_element", window: "Notes", element: "Save" },
					],
				},
				{ state: { computerUseAllowedApps: ["Safari"] } },
			)
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(/Step 2: The window .{0,2}Notes/)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		})

		it("treats a focus_window step as changing the active window for later steps", async () => {
			const { callbacks } = await run(
				{
					actions: [
						{ action: "focus_window", window: "7" },
						{ action: "type", text: "x" },
					],
				},
				{ state: { computerUseAllowedApps: ["Safari"] } },
			)
			expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
			expect(session.executeBatch.mock.calls[0][1]).toHaveProperty("beforeStep")
		})

		describe("background mode", () => {
			const realPlatform = process.platform
			afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform }))

			it("rejects a step that background mode does not allow, before approval", async () => {
				Object.defineProperty(process, "platform", { value: "darwin" })
				const { callbacks } = await run(
					{
						actions: [
							{ action: "click_element", window: "Notes", element: "Save" },
							{ action: "click", coordinate: "1,1" },
						],
					},
					{ state: { computerUseBackgroundMode: true } },
				)
				expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(
					/Step 2: .{0,2}click.{0,2} is not available in background mode/,
				)
				expect(callbacks.askApproval).not.toHaveBeenCalled()
			})

			it("allows a batch of background actions", async () => {
				Object.defineProperty(process, "platform", { value: "darwin" })
				const { callbacks } = await run(
					{
						actions: [
							{ action: "window_type", window: "Notes", text: "hi" },
							{ action: "click_element", window: "Notes", element: "Send" },
						],
					},
					{ state: { computerUseBackgroundMode: true } },
				)
				expect(callbacks.askApproval).toHaveBeenCalledTimes(1)
				expect(session.executeBatch).toHaveBeenCalled()
			})
		})

		it("reports the failed step and how many finished, with the screenshot", async () => {
			session.executeBatch.mockImplementationOnce(async (steps) => ({
				screenshot: SHOT,
				screenshotWidth: 1232,
				screenshotHeight: 800,
				completed: [{ params: steps[0] }],
				failed: { index: 1, message: "coordinate 9999,1 is outside the screenshot" },
			}))
			const { callbacks, task } = await run({ actions: batch })
			const result = callbacks.pushToolResult.mock.calls[0][0]
			expect(result[0].type).toBe("image")
			const text = result[result.length - 1].text
			expect(text).toMatch(/step 2 of 3 \(click\) failed: coordinate 9999,1 is outside/)
			expect(text).toMatch(/1 of 3 steps finished/)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.consecutiveMistakeCount).toBe(1)
		})

		it("lets the session stop the batch when the task is aborted", async () => {
			task = createTask()
			const callbacks = createCallbacks(true)
			session.executeBatch.mockImplementationOnce(async (steps, opts) => {
				const shouldAbort = (opts as { shouldAbort: () => boolean }).shouldAbort
				expect(shouldAbort()).toBe(false)
				;(task as { abort?: boolean }).abort = true
				expect(shouldAbort()).toBe(true)
				return { completed: [{ params: steps[0] }], abortedAt: 1 }
			})
			await new ComputerActionTool().execute({ actions: batch } as never, task as never, callbacks)
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		})
	})
})
