import { ComputerActionError, DesktopSession, isWindowAllowed, MAX_SCROLL_AMOUNT } from "../DesktopSession"
import type { DesktopDriver, DesktopWindow } from "../DesktopDriver"

/** Fake 2x Retina display: 200x100 logical points, 400x200 capture pixels. */
function createDriver(overrides: Partial<DesktopDriver> = {}) {
	const windows: DesktopWindow[] = [
		{ handle: 1, title: "Finder", rect: { x: 0, y: 0, width: 100, height: 50 } },
		{ handle: 2, title: "Notes - Shopping", rect: { x: 10, y: 10, width: 150, height: 80 } },
		{ handle: 3, title: "Notes - Work", rect: { x: 20, y: 20, width: 150, height: 80 } },
	]
	const driver = {
		getScreenSize: vi.fn(() => ({ width: 200, height: 100 })),
		captureScreen: vi.fn(() => ({
			width: 400,
			height: 200,
			byteWidth: 1600,
			bytesPerPixel: 4,
			image: Buffer.alloc(1600 * 200),
		})),
		getMousePosition: vi.fn(() => ({ x: 100, y: 50 })),
		moveMouse: vi.fn(),
		click: vi.fn(),
		drag: vi.fn(),
		scroll: vi.fn(),
		keyTap: vi.fn(),
		typeText: vi.fn(),
		listWindows: vi.fn(() => windows),
		getActiveWindowHandle: vi.fn(() => 2),
		focusWindow: vi.fn(),
		...overrides,
	}
	return driver
}

function createSession(driver = createDriver(), platform = "darwin") {
	const sleep = vi.fn(async () => {})
	// maxWidth 100 -> screenshot is 100x50, so screenshot->screen scale is 2.
	const session = new DesktopSession(driver, { maxWidth: 100, maxHeight: 100, settleMs: 250, platform, sleep })
	return { session, driver, sleep }
}

describe("DesktopSession sharing with the user", () => {
	function createSharedSession(idle: boolean) {
		const driver = createDriver()
		const activity = {
			waitForIdle: vi.fn(async () => ({ idle, waitedMs: idle ? 0 : 20_000 })),
			noteInjected: vi.fn(),
		}
		const background = {
			captureWindow: vi.fn(async () => ({ dataUrl: "data:image/png;base64,AAAA", width: 300, height: 200 })),
			typeInWindow: vi.fn(async () => {}),
			listElements: vi.fn(async () => [
				{ role: "Button", name: "Save", x: 40, y: 20 },
				{ role: "TextField", name: "Search" },
			]),
			pressElement: vi.fn(async (_id: number, name: string) => ({ role: "Button", name })),
		}
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 0,
			platform: "darwin",
			sleep: async () => {},
			activity: activity as never,
			background,
		})
		return { session, driver, activity, background }
	}

	it("waits for the user before a click and puts the cursor back afterwards", async () => {
		const { session, driver, activity } = createSharedSession(true)
		await session.execute({ action: "click", coordinate: "10,10" })

		expect(activity.waitForIdle).toHaveBeenCalledTimes(1)
		// Click target (20,20 in screen points), then back to the user's cursor (100,50).
		expect(driver.moveMouse).toHaveBeenNthCalledWith(1, { x: 20, y: 20 })
		expect(driver.moveMouse).toHaveBeenLastCalledWith({ x: 100, y: 50 })
		expect(activity.noteInjected).toHaveBeenCalled()
	})

	it("leaves the cursor where it was moved for the move action", async () => {
		const { session, driver } = createSharedSession(true)
		await session.execute({ action: "move", coordinate: "10,10" })
		expect(driver.moveMouse).toHaveBeenCalledTimes(1)
	})

	it("does not wait for the user for screenshots", async () => {
		const { session, activity } = createSharedSession(false)
		await session.execute({ action: "screenshot" })
		expect(activity.waitForIdle).not.toHaveBeenCalled()
	})

	it("refuses shared-input actions while the user is busy and suggests background actions", async () => {
		const { session, driver } = createSharedSession(false)
		await expect(session.execute({ action: "type", text: "hi" })).rejects.toThrow(/window_type/)
		expect(driver.typeText).not.toHaveBeenCalled()
	})

	it("window_screenshot captures one window without touching input or waiting", async () => {
		const { session, driver, activity, background } = createSharedSession(false)
		const result = await session.execute({ action: "window_screenshot", window: "Work" })

		expect(background.captureWindow).toHaveBeenCalledWith(3, 100)
		expect(result.windowTitle).toBe("Notes - Work")
		expect(result.screenshotWidth).toBe(300)
		expect(activity.waitForIdle).not.toHaveBeenCalled()
		expect(driver.moveMouse).not.toHaveBeenCalled()
	})

	it("window_type types into the window in the background while the user is busy", async () => {
		const { session, driver, background } = createSharedSession(false)
		const result = await session.execute({ action: "window_type", window: "Shopping", text: "milk" })

		expect(background.typeInWindow).toHaveBeenCalledWith(2, "milk")
		expect(driver.typeText).not.toHaveBeenCalled()
		expect(result.windowTitle).toBe("Notes - Shopping")
	})

	it("explains a window_type failure", async () => {
		const { session, background } = createSharedSession(true)
		background.typeInWindow.mockRejectedValueOnce(new Error("no focused text element"))
		await expect(session.execute({ action: "window_type", window: "Work", text: "x" })).rejects.toThrow(
			/no focused text element/,
		)
	})

	it("list_elements returns element names with centers in screenshot pixels", async () => {
		const { session, background, activity } = createSharedSession(false)
		const result = await session.execute({ action: "list_elements", window: "Work" })

		expect(background.listElements).toHaveBeenCalledWith(3)
		// Screen 200x100 points -> screenshot 100x50, so 40,20 maps to 20,10.
		expect(result.elements).toEqual([
			{ role: "Button", name: "Save", center: "20,10" },
			{ role: "TextField", name: "Search", center: undefined },
		])
		expect(activity.waitForIdle).not.toHaveBeenCalled()
	})

	it("click_element presses the element without the pointer, even while the user is busy", async () => {
		const { session, driver, background } = createSharedSession(false)
		const result = await session.execute({ action: "click_element", window: "Work", element: "Save" })

		expect(background.pressElement).toHaveBeenCalledWith(3, "Save")
		expect(driver.click).not.toHaveBeenCalled()
		expect(driver.moveMouse).not.toHaveBeenCalled()
		expect(result.windowTitle).toBe("Notes - Work")
	})

	it("click_element explains a missing element", async () => {
		const { session, background } = createSharedSession(true)
		background.pressElement.mockRejectedValueOnce(new Error('no element named "Nope"'))
		await expect(session.execute({ action: "click_element", window: "Work", element: "Nope" })).rejects.toThrow(
			/list_elements/,
		)
	})

	it("rejects background actions where they are not available", async () => {
		const { session } = createSession(createDriver(), "win32")
		await expect(session.execute({ action: "window_screenshot", window: "Work" })).rejects.toThrow(
			/only available on macOS/,
		)
	})
})

describe("DesktopSession fast capture and paste", () => {
	it("uses the fast capture (JPEG) and maps coordinates from its size", async () => {
		const driver = createDriver()
		const fastCapture = vi.fn(async (width: number, height: number) => ({
			dataUrl: "data:image/jpeg;base64,/9j/",
			width,
			height,
		}))
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 0,
			sleep: async () => {},
			fastCapture,
		})
		const result = await session.execute({ action: "screenshot" })

		expect(fastCapture).toHaveBeenCalledWith(100, 50)
		expect(result.screenshot).toMatch(/^data:image\/jpeg/)
		expect(driver.captureScreen).not.toHaveBeenCalled()
		expect(session.toScreenPoint("50,25")).toEqual({ x: 100, y: 50 })
	})

	it("falls back to the libnut PNG capture when the fast capture fails", async () => {
		const driver = createDriver()
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 0,
			sleep: async () => {},
			fastCapture: async () => {
				throw new Error("screencapture failed")
			},
		})
		const result = await session.execute({ action: "screenshot" })
		expect(result.screenshot).toMatch(/^data:image\/png/)
		expect(driver.captureScreen).toHaveBeenCalled()
	})

	function createPasteSession() {
		const driver = createDriver()
		let clip = "user clipboard"
		const clipboard = {
			read: vi.fn(async () => clip),
			write: vi.fn(async (text: string) => {
				clip = text
			}),
		}
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 0,
			platform: "darwin",
			sleep: async () => {},
			clipboard,
		})
		return { session, driver, clipboard, current: () => clip }
	}

	it("types short text key by key", async () => {
		const { session, driver, clipboard } = createPasteSession()
		await session.execute({ action: "type", text: "hello" })
		expect(driver.typeText).toHaveBeenCalledWith("hello")
		expect(clipboard.write).not.toHaveBeenCalled()
	})

	it("pastes long text and restores the user's clipboard", async () => {
		const { session, driver, clipboard, current } = createPasteSession()
		const text = "a".repeat(200)
		await session.execute({ action: "type", text })

		expect(clipboard.write).toHaveBeenNthCalledWith(1, text)
		expect(driver.keyTap).toHaveBeenCalledWith("v", ["command"])
		expect(driver.typeText).not.toHaveBeenCalled()
		expect(current()).toBe("user clipboard")
	})

	it("falls back to typing when the clipboard cannot be written", async () => {
		const { session, driver, clipboard } = createPasteSession()
		clipboard.write.mockRejectedValueOnce(new Error("denied"))
		const text = "b".repeat(100)
		await session.execute({ action: "type", text })
		expect(driver.typeText).toHaveBeenCalledWith(text)
	})
})

describe("DesktopSession", () => {
	describe("screenshot", () => {
		it("returns a downscaled PNG data URL and the cursor in screenshot space", () => {
			const { session } = createSession()
			const shot = session.screenshot()
			expect(shot.dataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/)
			expect(shot).toMatchObject({ width: 100, height: 50, cursor: { x: 50, y: 25 } })
		})

		it("explains an empty capture (missing macOS Screen Recording permission)", () => {
			const driver = createDriver({
				captureScreen: () => ({ width: 0, height: 0, byteWidth: 0, bytesPerPixel: 4, image: Buffer.alloc(0) }),
			})
			expect(() => createSession(driver).session.screenshot()).toThrow(/Screen Recording/)
		})
	})

	describe("coordinate mapping", () => {
		it("maps screenshot pixels to logical points", () => {
			const { session } = createSession()
			session.screenshot()
			expect(session.toScreenPoint("50,25")).toEqual({ x: 100, y: 50 })
			expect(session.toScreenPoint("(10, 5)")).toEqual({ x: 20, y: 10 })
			expect(session.toScreenPoint("99.6,49.9")).toEqual({ x: 199, y: 99 })
		})

		it("takes a screenshot first if none exists yet", () => {
			const { session, driver } = createSession()
			expect(session.toScreenPoint("50,25")).toEqual({ x: 100, y: 50 })
			expect(driver.captureScreen).toHaveBeenCalledOnce()
		})

		it.each([
			[undefined, /Missing "coordinate"/],
			["50", /Invalid coordinate/],
			["a,b", /Invalid coordinate/],
			["100,10", /outside the screenshot \(100x50\)/],
			["-1,10", /outside/],
		])("rejects %j", (input, message) => {
			const { session } = createSession()
			session.screenshot()
			expect(() => session.toScreenPoint(input)).toThrow(message)
		})
	})

	describe("execute", () => {
		it("clicks at the mapped point, waits, and returns a fresh screenshot", async () => {
			const { session, driver, sleep } = createSession()
			session.screenshot()
			const result = await session.execute({ action: "click", coordinate: "25,10" })

			expect(driver.moveMouse).toHaveBeenCalledWith({ x: 50, y: 20 })
			expect(driver.click).toHaveBeenCalledWith("left", false)
			expect(sleep).toHaveBeenCalledWith(250)
			expect(result).toMatchObject({
				executedCoordinate: "50,20",
				screenshotWidth: 100,
				screenshotHeight: 50,
				activeWindowTitle: "Notes - Shopping",
			})
			expect(result.screenshot).toMatch(/^data:image\/png;base64,/)
		})

		it.each([
			["double_click", "left", true],
			["right_click", "right", false],
		] as const)("%s uses button %s, double=%s", async (action, button, double) => {
			const { session, driver } = createSession()
			await session.execute({ action, coordinate: "1,1" })
			expect(driver.click).toHaveBeenCalledWith(button, double)
		})

		it("drags between two mapped points", async () => {
			const { session, driver } = createSession()
			await session.execute({ action: "drag", coordinate: "10,10", end_coordinate: "40,20" })
			expect(driver.drag).toHaveBeenCalledWith({ x: 20, y: 20 }, { x: 80, y: 40 })
		})

		it("requires end_coordinate for drag", async () => {
			const { session } = createSession()
			await expect(session.execute({ action: "drag", coordinate: "10,10" })).rejects.toThrow(/end_coordinate/)
		})

		it("parses key combos for the session platform", async () => {
			const { session, driver } = createSession(createDriver(), "win32")
			await session.execute({ action: "key", key: "cmd+shift+s" })
			expect(driver.keyTap).toHaveBeenCalledWith("s", ["control", "shift"])
		})

		it("turns key parse errors into ComputerActionError", async () => {
			const { session } = createSession()
			await expect(session.execute({ action: "key", key: "ctrl+banana" })).rejects.toBeInstanceOf(
				ComputerActionError,
			)
		})

		it("types text and rejects empty text", async () => {
			const { session, driver } = createSession()
			await session.execute({ action: "type", text: "hello" })
			expect(driver.typeText).toHaveBeenCalledWith("hello")
			await expect(session.execute({ action: "type", text: "" })).rejects.toThrow(/Missing "text"/)
		})

		it("scrolls with direction and clamped amount, optionally moving first", async () => {
			const { session, driver } = createSession()
			await session.execute({ action: "scroll", direction: "up", amount: "999", coordinate: "5,5" })
			expect(driver.moveMouse).toHaveBeenCalledWith({ x: 10, y: 10 })
			expect(driver.scroll).toHaveBeenCalledWith(0, -MAX_SCROLL_AMOUNT)

			await session.execute({ action: "scroll" })
			expect(driver.scroll).toHaveBeenLastCalledWith(0, 3)
		})

		it("rejects an invalid scroll direction", async () => {
			const { session } = createSession()
			await expect(session.execute({ action: "scroll", direction: "sideways" as never })).rejects.toThrow(
				/Invalid direction/,
			)
		})

		it("waits for a bounded duration and returns a screenshot", async () => {
			const { session, sleep } = createSession()
			const result = await session.execute({ action: "wait", duration: "60000" })
			expect(sleep).toHaveBeenCalledWith(10_000)
			expect(result.screenshot).toBeDefined()
		})

		it("lists windows with the active flag and no screenshot", async () => {
			const { session, driver } = createSession()
			const result = await session.execute({ action: "list_windows" })
			expect(result.windows?.map((w) => [w.id, w.active])).toEqual([
				[1, false],
				[2, true],
				[3, false],
			])
			expect(result.screenshot).toBeUndefined()
			expect(driver.captureScreen).not.toHaveBeenCalled()
		})

		describe("focus_window", () => {
			it("focuses by id", async () => {
				const { session, driver } = createSession()
				await session.execute({ action: "focus_window", window: "3" })
				expect(driver.focusWindow).toHaveBeenCalledWith(3)
			})

			it("focuses by unique case-insensitive title match", async () => {
				const { session, driver } = createSession()
				await session.execute({ action: "focus_window", window: "finder" })
				expect(driver.focusWindow).toHaveBeenCalledWith(1)
			})

			it("rejects an ambiguous title and lists the candidates", async () => {
				const { session } = createSession()
				await expect(session.execute({ action: "focus_window", window: "notes" })).rejects.toThrow(
					/matches 2 windows: 2 "Notes - Shopping", 3 "Notes - Work"/,
				)
			})

			it("rejects an unknown window", async () => {
				const { session } = createSession()
				await expect(session.execute({ action: "focus_window", window: "Safari" })).rejects.toThrow(
					/No window matches/,
				)
			})
		})

		it("rejects unknown actions", async () => {
			const { session } = createSession()
			await expect(session.execute({ action: "explode" as never })).rejects.toThrow(/Unknown action/)
		})
	})
})

describe("DesktopSession batches, submit, and screenshot: false", () => {
	function createBatchSession() {
		const driver = createDriver()
		const order: string[] = []
		const sleep = vi.fn(async (ms: number) => {
			order.push(`sleep ${ms}`)
		})
		const fastCapture = vi.fn(async (width: number, height: number) => {
			order.push("screenshot")
			return { dataUrl: "data:image/jpeg;base64,/9j/", width, height }
		})
		const activity = {
			waitForIdle: vi.fn(async () => {
				order.push("waitForIdle")
				return { idle: true, waitedMs: 0 }
			}),
			noteInjected: vi.fn(),
		}
		vi.mocked(driver.click).mockImplementation(() => {
			order.push("click")
		})
		vi.mocked(driver.typeText).mockImplementation((t: string) => {
			order.push(`type ${t}`)
		})
		vi.mocked(driver.keyTap).mockImplementation((k: string) => {
			order.push(`key ${k}`)
		})
		vi.mocked(driver.focusWindow).mockImplementation((id: number) => {
			order.push(`focus ${id}`)
		})
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 200,
			platform: "darwin",
			sleep,
			fastCapture,
			activity: activity as never,
		})
		return { session, driver, order, sleep, fastCapture, activity }
	}

	it("runs steps in order, waits for the user before each, settles once, and takes one screenshot", async () => {
		const { session, order, fastCapture, activity, sleep } = createBatchSession()
		await session.execute({ action: "screenshot" })
		order.length = 0
		fastCapture.mockClear()

		const result = await session.executeBatch([
			{ action: "focus_window", window: "Finder" },
			{ action: "click", coordinate: "10,10" },
			{ action: "type", text: "hi", submit: true },
		])

		expect(order).toEqual([
			"waitForIdle",
			"focus 1",
			"sleep 50",
			"waitForIdle",
			"click",
			"sleep 50",
			"waitForIdle",
			"type hi",
			"key enter",
			"sleep 200",
			"screenshot",
		])
		expect(activity.waitForIdle).toHaveBeenCalledTimes(3)
		expect(fastCapture).toHaveBeenCalledTimes(1)
		expect(sleep.mock.calls.filter(([ms]) => ms === 200)).toHaveLength(1)
		expect(result.screenshot).toMatch(/^data:image\/jpeg/)
		expect(result.completed.map((c) => [c.params.action, c.executedCoordinate])).toEqual([
			["focus_window", undefined],
			["click", "20,20"],
			["type", undefined],
		])
		expect(result.failed).toBeUndefined()
	})

	it("stops at a failing step, names it, and still returns a screenshot", async () => {
		const { session, driver, fastCapture } = createBatchSession()
		await session.execute({ action: "screenshot" })
		fastCapture.mockClear()

		const result = await session.executeBatch([
			{ action: "click", coordinate: "10,10" },
			{ action: "click", coordinate: "999,10" },
			{ action: "type", text: "never" },
		])

		expect(result.failed).toEqual({ index: 1, message: expect.stringMatching(/outside the screenshot/) })
		expect(result.completed).toHaveLength(1)
		expect(driver.typeText).not.toHaveBeenCalled()
		expect(fastCapture).toHaveBeenCalledTimes(1)
		expect(result.screenshot).toBeDefined()
	})

	it("stops between steps when the task is aborted", async () => {
		const { session, driver, fastCapture } = createBatchSession()
		let aborted = false
		vi.mocked(driver.click).mockImplementation(() => {
			aborted = true
		})
		await session.execute({ action: "screenshot" })
		fastCapture.mockClear()

		const result = await session.executeBatch(
			[
				{ action: "click", coordinate: "10,10" },
				{ action: "type", text: "never" },
			],
			{ shouldAbort: () => aborted },
		)

		expect(result.abortedAt).toBe(1)
		expect(result.completed).toHaveLength(1)
		expect(driver.typeText).not.toHaveBeenCalled()
		expect(fastCapture).not.toHaveBeenCalled()
	})

	it("stops when beforeStep throws (for example, a window outside the allowlist)", async () => {
		const { session, driver } = createBatchSession()
		const result = await session.executeBatch([{ action: "type", text: "x" }], {
			beforeStep: () => {
				throw new ComputerActionError("not in the allowlist")
			},
		})
		expect(result.failed).toEqual({ index: 0, message: "not in the allowlist" })
		expect(driver.typeText).not.toHaveBeenCalled()
	})

	it("skips the settle wait and the screenshot for a batch with screenshot: false", async () => {
		const { session, sleep, fastCapture } = createBatchSession()
		const result = await session.executeBatch([{ action: "key", key: "a" }], { screenshot: false })
		expect(fastCapture).not.toHaveBeenCalled()
		expect(sleep).not.toHaveBeenCalledWith(200)
		expect(result.screenshot).toBeUndefined()
		expect(result.completed).toHaveLength(1)
	})

	it("submit presses Enter after the text", async () => {
		const { session, order } = createBatchSession()
		await session.execute({ action: "type", text: "hello", submit: true })
		expect(order.indexOf("key enter")).toBe(order.indexOf("type hello") + 1)
	})

	it("submit presses Enter after pasted long text", async () => {
		const driver = createDriver()
		const clipboard = { read: vi.fn(async () => "old"), write: vi.fn(async () => {}) }
		const session = new DesktopSession(driver, {
			maxWidth: 100,
			maxHeight: 100,
			settleMs: 0,
			platform: "darwin",
			sleep: async () => {},
			clipboard,
		})
		await session.execute({ action: "type", text: "a".repeat(100), submit: true })
		expect(vi.mocked(driver.keyTap).mock.calls).toEqual([
			["v", ["command"]],
			["enter", []],
		])
	})

	it("does not press Enter without submit", async () => {
		const { session, driver } = createBatchSession()
		await session.execute({ action: "type", text: "hello" })
		expect(driver.keyTap).not.toHaveBeenCalled()
	})

	it("rejects submit for window_type", async () => {
		const driver = createDriver()
		const background = {
			captureWindow: vi.fn(),
			typeInWindow: vi.fn(),
			listElements: vi.fn(),
			pressElement: vi.fn(),
		}
		const session = new DesktopSession(driver, { sleep: async () => {}, background: background as never })
		await expect(
			session.execute({ action: "window_type", window: "Finder", text: "x", submit: true }),
		).rejects.toThrow(/submit is not available for window_type/)
		expect(background.typeInWindow).not.toHaveBeenCalled()
	})

	it("screenshot: false on a single action returns no image and does not settle", async () => {
		const { session, sleep, fastCapture } = createBatchSession()
		await session.execute({ action: "screenshot" })
		fastCapture.mockClear()
		const result = await session.execute({ action: "click", coordinate: "10,10" }, { screenshot: false })
		expect(result.screenshot).toBeUndefined()
		expect(result.executedCoordinate).toBe("20,20")
		expect(fastCapture).not.toHaveBeenCalled()
		expect(sleep).not.toHaveBeenCalledWith(200)
	})

	it("uses a 200 ms default settle wait", async () => {
		const { DEFAULT_SETTLE_MS } = await import("../DesktopSession")
		expect(DEFAULT_SETTLE_MS).toBe(200)
	})
})

describe("isWindowAllowed", () => {
	it("allows everything when the allowlist is empty or blank", () => {
		expect(isWindowAllowed("Anything", undefined)).toBe(true)
		expect(isWindowAllowed(undefined, [])).toBe(true)
		expect(isWindowAllowed("Anything", ["  "])).toBe(true)
	})

	it("matches case-insensitive substrings", () => {
		expect(isWindowAllowed("Notes - Shopping", ["notes"])).toBe(true)
		expect(isWindowAllowed("Google Chrome", ["Safari", "chrome"])).toBe(true)
		expect(isWindowAllowed("Terminal", ["notes"])).toBe(false)
	})

	it("denies an unknown title when an allowlist is set", () => {
		expect(isWindowAllowed(undefined, ["notes"])).toBe(false)
	})
})
