import { parseHidIdleMs, UserActivityMonitor } from "../userActivity"
import type { Point } from "../DesktopDriver"

/** Fake clock where sleep advances time instantly. */
function createClock(start = 100_000) {
	let now = start
	return {
		now: () => now,
		sleep: vi.fn(async (ms: number) => {
			now += ms
		}),
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe("UserActivityMonitor", () => {
	it("returns at once when there is no sign of user input", async () => {
		const clock = createClock()
		const monitor = new UserActivityMonitor({
			getCursor: () => ({ x: 10, y: 10 }),
			idleProbe: async () => 60_000,
			now: clock.now,
			sleep: clock.sleep,
		})
		await expect(monitor.waitForIdle()).resolves.toEqual({ idle: true, waitedMs: 0 })
		expect(clock.sleep).not.toHaveBeenCalled()
	})

	it("waits while the cursor keeps moving, then continues after a quiet period", async () => {
		const clock = createClock()
		const positions: Point[] = [
			{ x: 50, y: 50 }, // initial check: moved away from Roo's last position
			{ x: 50, y: 50 },
			{ x: 60, y: 50 }, // still moving
			{ x: 70, y: 50 },
		]
		let i = 0
		const monitor = new UserActivityMonitor({
			getCursor: () => positions[Math.min(i++, positions.length - 1)],
			quietMs: 1000,
			now: clock.now,
			sleep: clock.sleep,
		})
		monitor.noteInjected({ x: 10, y: 10 })

		const result = await monitor.waitForIdle()

		expect(result.idle).toBe(true)
		// Last movement was seen after two polls (500 ms); then 1000 ms of quiet.
		expect(result.waitedMs).toBeGreaterThanOrEqual(1500)
	})

	it("gives up after maxWaitMs when the user keeps working", async () => {
		const clock = createClock()
		let x = 0
		const monitor = new UserActivityMonitor({
			getCursor: () => ({ x: (x += 10), y: 0 }),
			quietMs: 1000,
			maxWaitMs: 3000,
			now: clock.now,
			sleep: clock.sleep,
		})
		monitor.noteInjected({ x: -100, y: 0 })

		const result = await monitor.waitForIdle()

		expect(result.idle).toBe(false)
		expect(result.waitedMs).toBeGreaterThanOrEqual(3000)
	})

	it("treats recent keyboard input (HID idle) as activity", async () => {
		const clock = createClock()
		let idleMs = 100 // user typed 100 ms ago
		const monitor = new UserActivityMonitor({
			getCursor: () => ({ x: 10, y: 10 }),
			idleProbe: async () => idleMs,
			quietMs: 1000,
			now: clock.now,
			sleep: async (ms) => {
				await clock.sleep(ms)
				idleMs += ms
			},
		})

		const result = await monitor.waitForIdle()

		expect(result.idle).toBe(true)
		expect(result.waitedMs).toBeGreaterThanOrEqual(900)
	})

	it("ignores HID activity caused by Roo's own input", async () => {
		const clock = createClock()
		const monitor = new UserActivityMonitor({
			getCursor: () => ({ x: 10, y: 10 }),
			idleProbe: async () => 50, // the last event was Roo's, 50 ms ago
			now: clock.now,
			sleep: clock.sleep,
		})
		monitor.noteInjected({ x: 10, y: 10 })
		clock.advance(50)

		await expect(monitor.waitForIdle()).resolves.toEqual({ idle: true, waitedMs: 0 })
	})

	it("treats a failing idle probe as no signal", async () => {
		const clock = createClock()
		const monitor = new UserActivityMonitor({
			getCursor: () => ({ x: 10, y: 10 }),
			idleProbe: async () => {
				throw new Error("ioreg failed")
			},
			now: clock.now,
			sleep: clock.sleep,
		})
		await expect(monitor.waitForIdle()).resolves.toEqual({ idle: true, waitedMs: 0 })
	})
})

describe("parseHidIdleMs", () => {
	it("reads HIDIdleTime in nanoseconds and returns milliseconds", () => {
		expect(parseHidIdleMs('  |   "HIDIdleTime" = 239746541\n')).toBeCloseTo(239.746541)
	})

	it("returns undefined when the value is missing", () => {
		expect(parseHidIdleMs("no idle time here")).toBeUndefined()
	})
})
