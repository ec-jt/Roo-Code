import { LibnutDriver, SCROLL_X_SIGN, SCROLL_Y_SIGN } from "../LibnutDriver"
import type { LibnutNative } from "../libnutLoader"

function createNative() {
	return {
		getScreenSize: vi.fn(() => ({ width: 1512, height: 982 })),
		captureScreen: vi.fn(() => ({
			width: 2,
			height: 1,
			byteWidth: 8,
			bitsPerPixel: 32,
			bytesPerPixel: 4,
			image: Buffer.alloc(8),
		})),
		getMousePos: vi.fn(() => ({ x: 10, y: 20 })),
		moveMouse: vi.fn(),
		mouseClick: vi.fn(),
		mouseToggle: vi.fn(),
		dragMouse: vi.fn(),
		scrollMouse: vi.fn(),
		keyTap: vi.fn(),
		typeString: vi.fn(),
		setMouseDelay: vi.fn(),
		setKeyboardDelay: vi.fn(),
		getWindows: vi.fn(() => [1, 2, 3, 4]),
		getActiveWindow: vi.fn(() => 2),
		getWindowTitle: vi.fn((h: number) => ({ 1: "Finder", 2: "Notes", 3: "", 4: "Gone" })[h] ?? ""),
		getWindowRect: vi.fn((h: number) => {
			if (h === 4) throw new Error("window closed")
			return { x: 0, y: 0, width: h === 3 ? 0 : 800, height: 600 }
		}),
		focusWindow: vi.fn(),
	} satisfies LibnutNative
}

describe("LibnutDriver", () => {
	it("sets input delays on construction", () => {
		const native = createNative()
		new LibnutDriver(native)
		expect(native.setMouseDelay).toHaveBeenCalledWith(10)
		expect(native.setKeyboardDelay).toHaveBeenCalledWith(10)
	})

	it("rounds coordinates when moving the mouse", () => {
		const native = createNative()
		new LibnutDriver(native).moveMouse({ x: 10.6, y: 20.4 })
		expect(native.moveMouse).toHaveBeenCalledWith(11, 20)
	})

	it("passes button and double flag to mouseClick", () => {
		const native = createNative()
		new LibnutDriver(native).click("right", true)
		expect(native.mouseClick).toHaveBeenCalledWith("right", true)
	})

	it("drags by pressing, moving, and releasing the left button", () => {
		const native = createNative()
		new LibnutDriver(native).drag({ x: 1, y: 2 }, { x: 30, y: 40 })
		expect(native.moveMouse).toHaveBeenCalledWith(1, 2)
		expect(native.mouseToggle).toHaveBeenNthCalledWith(1, "down", "left")
		expect(native.dragMouse).toHaveBeenCalledWith(30, 40)
		expect(native.mouseToggle).toHaveBeenNthCalledWith(2, "up", "left")
	})

	it("releases the mouse button even if the drag throws", () => {
		const native = createNative()
		native.dragMouse.mockImplementation(() => {
			throw new Error("boom")
		})
		expect(() => new LibnutDriver(native).drag({ x: 0, y: 0 }, { x: 5, y: 5 })).toThrow("boom")
		expect(native.mouseToggle).toHaveBeenLastCalledWith("up", "left")
	})

	it("applies the scroll sign convention", () => {
		const native = createNative()
		new LibnutDriver(native, "linux").scroll(2, 3)
		expect(native.scrollMouse).toHaveBeenCalledWith(2 * SCROLL_X_SIGN, 3 * SCROLL_Y_SIGN)
	})

	it.each([
		["darwin", 40],
		["win32", 120],
		["linux", 1],
		["freebsd", 1],
	])("scales wheel steps to native units on %s", (platform, units) => {
		const native = createNative()
		new LibnutDriver(native, platform).scroll(0, 3)
		expect(native.scrollMouse).toHaveBeenCalledWith(0, 3 * units * SCROLL_Y_SIGN)
	})

	it("omits the modifier argument when there are no modifiers", () => {
		const native = createNative()
		const driver = new LibnutDriver(native)
		driver.keyTap("enter", [])
		driver.keyTap("c", ["control", "shift"])
		expect(native.keyTap).toHaveBeenNthCalledWith(1, "enter")
		expect(native.keyTap).toHaveBeenNthCalledWith(2, "c", ["control", "shift"])
	})

	it('sends the Command / Windows key as "meta" (libnut rejects "command")', () => {
		const native = createNative()
		new LibnutDriver(native).keyTap("c", ["command", "shift"])
		expect(native.keyTap).toHaveBeenCalledWith("c", ["meta", "shift"])
	})

	it("waits for the cursor to reach the move target", () => {
		const native = createNative()
		let calls = 0
		// The first two reads still report the old position, as macOS does on the first move.
		vi.mocked(native.getMousePos).mockImplementation(() => (++calls < 3 ? { x: 0, y: 0 } : { x: 50, y: 60 }))
		new LibnutDriver(native).moveMouse({ x: 50, y: 60 })
		expect(native.moveMouse).toHaveBeenCalledWith(50, 60)
		expect(calls).toBe(3)
	})

	it("lists windows, skipping untitled, empty, and closed ones", () => {
		const native = createNative()
		const windows = new LibnutDriver(native).listWindows()
		expect(windows.map((w) => w.title)).toEqual(["Finder", "Notes"])
		expect(windows[1]).toEqual({ handle: 2, title: "Notes", rect: { x: 0, y: 0, width: 800, height: 600 } })
	})

	it("returns capture metadata unchanged", () => {
		const native = createNative()
		const capture = new LibnutDriver(native).captureScreen()
		expect(capture).toMatchObject({ width: 2, height: 1, byteWidth: 8, bytesPerPixel: 4 })
	})
})
