import { execFile } from "child_process"

import type { Point } from "./DesktopDriver"

/**
 * Detects when the user is using the mouse or keyboard, so computer_action can
 * take turns with the user instead of fighting over the one real cursor.
 *
 * Signals:
 * - Cursor moved since Roo's last input (all platforms).
 * - Cursor moving while Roo waits (all platforms).
 * - macOS only: HID idle time from IOHIDSystem, which also covers the keyboard.
 *   Roo's own synthetic events also reset the idle time, so only input newer
 *   than Roo's last injected event counts.
 */

export const DEFAULT_QUIET_MS = 1500
export const DEFAULT_MAX_WAIT_MS = 20_000
export const POLL_MS = 250
/** Synthetic events can land a little after the call returns. */
const INJECTION_GRACE_MS = 150
/** Cursor positions within this many points count as unchanged. */
const CURSOR_TOLERANCE = 2

export type IdleProbe = () => Promise<number | undefined>

export interface UserActivityMonitorOptions {
	getCursor: () => Point
	/** Milliseconds since the last HID input, or undefined if unknown. */
	idleProbe?: IdleProbe
	quietMs?: number
	maxWaitMs?: number
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}

export interface WaitResult {
	/** True when the user is idle and Roo may act. */
	idle: boolean
	/** Milliseconds spent waiting. */
	waitedMs: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function samePoint(a: Point, b: Point): boolean {
	return Math.abs(a.x - b.x) <= CURSOR_TOLERANCE && Math.abs(a.y - b.y) <= CURSOR_TOLERANCE
}

export class UserActivityMonitor {
	private lastInjectedAt: number | undefined
	private lastInjectedCursor: Point | undefined
	private readonly getCursor: () => Point
	private readonly idleProbe: IdleProbe | undefined
	private readonly quietMs: number
	private readonly maxWaitMs: number
	private readonly now: () => number
	private readonly sleep: (ms: number) => Promise<void>

	constructor(options: UserActivityMonitorOptions) {
		this.getCursor = options.getCursor
		this.idleProbe = options.idleProbe
		this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS
		this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
		this.now = options.now ?? Date.now
		this.sleep = options.sleep ?? defaultSleep
	}

	/** Record Roo's own input so it is not mistaken for user activity. */
	noteInjected(cursor?: Point): void {
		this.lastInjectedAt = this.now()
		if (cursor) {
			this.lastInjectedCursor = cursor
		}
	}

	/** Cursor position Roo left behind, if known. */
	get lastCursor(): Point | undefined {
		return this.lastInjectedCursor
	}

	/**
	 * Return immediately when there is no sign of user input. Otherwise wait
	 * until the user has been quiet for quietMs, or give up after maxWaitMs.
	 */
	async waitForIdle(): Promise<WaitResult> {
		const start = this.now()
		let lastActivityAt = await this.initialActivityAt()
		if (lastActivityAt === undefined) {
			return { idle: true, waitedMs: 0 }
		}

		let prevCursor = this.safeCursor()
		for (;;) {
			const now = this.now()
			if (now - lastActivityAt >= this.quietMs) {
				return { idle: true, waitedMs: now - start }
			}
			if (now - start >= this.maxWaitMs) {
				return { idle: false, waitedMs: now - start }
			}
			await this.sleep(POLL_MS)

			const cursor = this.safeCursor()
			if (cursor && prevCursor && !samePoint(cursor, prevCursor)) {
				lastActivityAt = this.now()
			}
			prevCursor = cursor ?? prevCursor

			const hidActivityAt = await this.userHidActivityAt()
			if (hidActivityAt !== undefined && hidActivityAt > lastActivityAt) {
				lastActivityAt = hidActivityAt
			}
		}
	}

	/** Time of the most recent user activity, or undefined when there is no sign of any. */
	private async initialActivityAt(): Promise<number | undefined> {
		const cursor = this.safeCursor()
		if (cursor && this.lastInjectedCursor && !samePoint(cursor, this.lastInjectedCursor)) {
			// The user moved the cursor after Roo's last action. When is unknown, so assume now.
			return this.now()
		}
		const hidActivityAt = await this.userHidActivityAt()
		if (hidActivityAt !== undefined && this.now() - hidActivityAt < this.quietMs) {
			return hidActivityAt
		}
		return undefined
	}

	/** Time of the latest HID input that is newer than Roo's own injected input. */
	private async userHidActivityAt(): Promise<number | undefined> {
		if (!this.idleProbe) {
			return undefined
		}
		let idleMs: number | undefined
		try {
			idleMs = await this.idleProbe()
		} catch {
			return undefined
		}
		if (idleMs === undefined || !Number.isFinite(idleMs)) {
			return undefined
		}
		const at = this.now() - idleMs
		if (this.lastInjectedAt !== undefined && at <= this.lastInjectedAt + INJECTION_GRACE_MS) {
			return undefined
		}
		return at
	}

	private safeCursor(): Point | undefined {
		try {
			return this.getCursor()
		} catch {
			return undefined
		}
	}
}

/** Parse HIDIdleTime (nanoseconds) from `ioreg -c IOHIDSystem` output. Returns milliseconds. */
export function parseHidIdleMs(output: string): number | undefined {
	const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(output)
	if (!match) {
		return undefined
	}
	return Number(match[1]) / 1_000_000
}

/** macOS idle probe using ioreg (no extra permission needed). Other platforms return undefined. */
export function createIdleProbe(platform: string = process.platform): IdleProbe | undefined {
	if (platform !== "darwin") {
		return undefined
	}
	return () =>
		new Promise((resolve) => {
			execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { timeout: 1000 }, (error, stdout) => {
				resolve(error ? undefined : parseHidIdleMs(String(stdout)))
			})
		})
}
