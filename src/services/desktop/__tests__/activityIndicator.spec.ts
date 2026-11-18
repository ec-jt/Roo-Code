import { DesktopActivityIndicator } from "../activityIndicator"

vi.mock("vscode", () => ({
	window: { createStatusBarItem: vi.fn() },
	StatusBarAlignment: { Left: 1 },
	ThemeColor: class {
		constructor(public id: string) {}
	},
}))

function createItem() {
	return {
		show: vi.fn(),
		hide: vi.fn(),
		dispose: vi.fn(),
		text: "",
		tooltip: "",
		command: "",
		backgroundColor: undefined,
	}
}

describe("DesktopActivityIndicator", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	function setup(lingerMs = 1000) {
		const item = createItem()
		const indicator = new DesktopActivityIndicator({ lingerMs, createItem: () => item as never })
		return { item, indicator }
	}

	it("shows a warning item that runs the stop command", () => {
		const { item, indicator } = setup()
		indicator.begin("click")
		expect(item.show).toHaveBeenCalled()
		expect(item.command).toBe("roo-cline.stopComputerUse")
		expect(item.text).toMatch(/controlling the desktop/)
		expect(item.tooltip).toMatch(/Last action: click/)
	})

	it("stays visible for the linger period after the last action, then hides", () => {
		const { item, indicator } = setup(1000)
		const end = indicator.begin("type")
		end()
		vi.advanceTimersByTime(999)
		expect(item.hide).not.toHaveBeenCalled()
		expect(indicator.isVisible()).toBe(true)
		vi.advanceTimersByTime(1)
		expect(item.hide).toHaveBeenCalledOnce()
		expect(indicator.isVisible()).toBe(false)
	})

	it("does not hide while another action is still running", () => {
		const { item, indicator } = setup(1000)
		const endA = indicator.begin("a")
		indicator.begin("b")
		endA()
		vi.advanceTimersByTime(5000)
		expect(item.hide).not.toHaveBeenCalled()
	})

	it("a new action cancels a pending hide", () => {
		const { item, indicator } = setup(1000)
		indicator.begin("a")()
		vi.advanceTimersByTime(500)
		const endB = indicator.begin("b")
		vi.advanceTimersByTime(5000)
		expect(item.hide).not.toHaveBeenCalled()
		endB()
		vi.advanceTimersByTime(1000)
		expect(item.hide).toHaveBeenCalledOnce()
	})

	it("ignores a second call to the same end function", () => {
		const { item, indicator } = setup(1000)
		const endA = indicator.begin("a")
		indicator.begin("b")
		endA()
		endA()
		vi.advanceTimersByTime(5000)
		expect(item.hide).not.toHaveBeenCalled()
	})

	it("reset hides immediately", () => {
		const { item, indicator } = setup(1000)
		indicator.begin("a")
		indicator.reset()
		expect(item.hide).toHaveBeenCalledOnce()
		expect(indicator.isVisible()).toBe(false)
	})
})
