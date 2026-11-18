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
