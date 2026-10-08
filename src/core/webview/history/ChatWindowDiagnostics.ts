import type { ChatWindowAck, ChatWindowState } from "@roo-code/types"

/** Metadata only. Bounded pending state and sampled logs, with no message bodies or file paths. */
export class ChatWindowDiagnostics {
	private pending = new Map<
		number,
		{ sentAt: number; window: ChatWindowState; received: boolean; timer: ReturnType<typeof setTimeout> }
	>()
	private lastLog = 0
	constructor(private readonly log: (message: string) => void) {}

	public sent(window: ChatWindowState) {
		// Keep the oldest outstanding samples. Evicting them on every streamed
		// update would hide a stalled renderer forever before its timeout fired.
		if (this.pending.size >= 20) return
		const timer = setTimeout(() => {
			const entry = this.pending.get(window.sequence)
			if (!entry) return
			this.pending.delete(window.sequence)
			this.report(entry.window, entry.received ? "render-unacked" : "webview-unacked", Date.now() - entry.sentAt)
		}, 10_000)
		timer.unref?.()
		// Keep metadata only, not the snapshot or live ask.
		const metadata = {
			taskId: window.taskId,
			instanceId: window.instanceId,
			sequence: window.sequence,
			byteLength: window.byteLength,
			totalMessages: window.totalMessages,
			startIndex: window.startIndex,
			endIndex: window.endIndex,
		} as ChatWindowState
		this.pending.set(window.sequence, { sentAt: Date.now(), window: metadata, received: false, timer })
	}

	public acknowledge(ack: ChatWindowAck) {
		const entry = this.pending.get(ack.sequence)
		if (!entry || ack.taskId !== entry.window.taskId || ack.instanceId !== entry.window.instanceId) return
		if (ack.phase === "received") entry.received = true
		else if (ack.phase === "rendered") {
			clearTimeout(entry.timer)
			this.pending.delete(ack.sequence)
			const duration = Date.now() - entry.sentAt
			if (duration > 1000) this.report(entry.window, "render-slow", duration)
		}
	}

	private report(window: ChatWindowState, phase: string, duration: number) {
		if (Date.now() - this.lastLog < 10_000) return
		this.lastLog = Date.now()
		this.log(
			`[chat-window] phase=${phase} sequence=${window.sequence} messages=${window.totalMessages} rows=${window.endIndex - window.startIndex} bytes=${window.byteLength} durationMs=${duration}`,
		)
	}

	public dispose() {
		for (const entry of this.pending.values()) clearTimeout(entry.timer)
		this.pending.clear()
	}
}
