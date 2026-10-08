import { randomUUID } from "crypto"

import type { ExitCodeDetails, RooTerminal, RooTerminalProcess } from "./types"

// Kept structurally compatible with the extension-host message type.
export interface CommandActivityInfo {
	id: string
	terminalId: number
	taskId?: string
	command: string
	cwd: string
	provider: "vscode" | "execa"
	startedAt: number
	endedAt?: number
	status: "running" | "completed" | "failed" | "unknown" | "stopping"
	exitCode?: number
	canStop: boolean
	canShowTerminal: boolean
	outputTail: string
}

interface Activity {
	info: CommandActivityInfo
	terminal: RooTerminal
	process: RooTerminalProcess
	started: boolean
	exited: boolean
	closed: boolean
	tail: string
	cleaner: OutputCleaner
	unsubscribe: () => void
}

const TAIL_BYTES = 8 * 1024
const HISTORY_LIMIT = 50

// This is best-effort display redaction, not a guarantee that output contains no secrets.
function redact(text: string): string {
	return text
		.replace(/(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s"'`,;]+/gi, "$1[redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*["']?)[^\s"'`,;]+/gi,
			"$1[redacted]",
		)
		.replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9]{8,}|github_pat_[a-zA-Z0-9_]{8,})/g, "[redacted]")
}

function bound(text: string): string {
	const bytes = Buffer.from(text)
	if (bytes.length <= TAIL_BYTES) return text
	// Do not split a UTF-8 code point.
	let start = bytes.length - TAIL_BYTES
	while ((bytes[start] & 0xc0) === 0x80) start++
	return bytes.subarray(start).toString("utf8")
}

/** Incremental ANSI/control stripping also handles escape sequences split across chunks. */
class OutputCleaner {
	private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text"

	append(chunk: string): string {
		let result = ""
		for (const char of chunk) {
			const code = char.charCodeAt(0)
			if (this.state === "stringEscape") {
				this.state = char === "\\" ? "text" : "string"
			} else if (this.state === "string") {
				if (code === 7 || code === 0x9c) this.state = "text"
				else if (code === 27) this.state = "stringEscape"
			} else if (this.state === "csi") {
				if (code >= 0x40 && code <= 0x7e) this.state = "text"
			} else if (this.state === "escape") {
				if (char === "[") this.state = "csi"
				else if ("]PX^_".includes(char)) this.state = "string"
				else if (code >= 0x30 && code <= 0x7e) this.state = "text"
			} else if (code === 27) this.state = "escape"
			else if (code === 0x9b) this.state = "csi"
			else if (code === 0x9d || code === 0x90) this.state = "string"
			else if (char === "\n" || char === "\t" || (code >= 32 && !(code >= 0x7f && code <= 0x9f))) {
				result += char
			}
		}
		return result
	}
}

/** Session-only activity for explicit Roo runCommand calls, not a system process monitor. */
export class CommandActivity {
	private static activities = new Map<string, Activity>()
	private static identities = new WeakMap<RooTerminalProcess, string>()
	private static latest = new WeakMap<RooTerminal, string>()
	private static listeners = new Set<() => void>()
	private static timer: ReturnType<typeof setTimeout> | undefined

	public static register(terminal: RooTerminal, process: RooTerminalProcess, command: string): string {
		const existing = this.identities.get(process)
		if (existing) return existing

		const previousId = this.latest.get(terminal)
		const previous = previousId ? this.activities.get(previousId) : undefined
		if (previous && !previous.exited) {
			previous.info.status = "unknown"
			previous.unsubscribe()
		}

		const id = randomUUID()
		const activity: Activity = {
			info: {
				id,
				terminalId: terminal.id,
				taskId: terminal.taskId,
				command: redact(new OutputCleaner().append(command)),
				cwd: terminal.getCurrentWorkingDirectory(),
				provider: terminal.provider,
				startedAt: Date.now(),
				status: "running",
				canStop: false,
				canShowTerminal: false,
				outputTail: "",
			},
			terminal,
			process,
			started: false,
			exited: false,
			closed: false,
			tail: "",
			cleaner: new OutputCleaner(),
			unsubscribe: () => {},
		}
		const started = () => {
			if (activity.exited || activity.closed || activity.info.status === "unknown") return
			activity.started = true
			this.changed()
		}
		const exited = (details: ExitCodeDetails) => {
			activity.exited = true
			if (details.exitCode !== undefined || details.signal || details.signalName) {
				activity.info.endedAt = Date.now()
			}
			activity.info.exitCode = details.exitCode
			activity.info.status =
				details.signalName || details.signal || (details.exitCode !== undefined && details.exitCode !== 0)
					? "failed"
					: details.exitCode === 0
						? "completed"
						: "unknown"
			this.changed()
		}
		const unknown = () => {
			if (!activity.exited) activity.info.status = "unknown"
			this.changed()
		}
		const error = () => {
			if (!activity.exited) activity.info.status = activity.started ? "unknown" : "failed"
			this.changed()
		}
		const output = (chunk: string) => {
			activity.tail = bound(activity.tail + activity.cleaner.append(chunk))
			this.changed()
		}
		process.on("shell_execution_started", started)
		process.on("shell_execution_complete", exited)
		process.on("no_shell_integration", unknown)
		process.on("error", error)
		process.on("activity_output", output)
		activity.unsubscribe = () => {
			process.off("shell_execution_started", started)
			process.off("shell_execution_complete", exited)
			process.off("no_shell_integration", unknown)
			process.off("error", error)
			process.off("activity_output", output)
		}
		this.activities.set(id, activity)
		this.identities.set(process, id)
		this.latest.set(terminal, id)
		this.changed()
		return id
	}

	private static isCurrent(activity: Activity): boolean {
		return (
			!activity.closed &&
			!activity.terminal.isClosed() &&
			this.latest.get(activity.terminal) === activity.info.id &&
			activity.terminal.process === activity.process
		)
	}

	private static canStop(activity: Activity): boolean {
		return (
			this.isCurrent(activity) &&
			activity.started &&
			!activity.exited &&
			activity.info.status === "running" &&
			activity.terminal.running
		)
	}

	public static snapshot(): CommandActivityInfo[] {
		return [...this.activities.values()].reverse().map((activity) => ({
			...activity.info,
			canStop: this.canStop(activity),
			canShowTerminal: activity.info.provider === "vscode" && this.isCurrent(activity),
			outputTail: bound(redact(activity.tail)),
		}))
	}

	public static onChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	public static stop(id: string): boolean {
		const activity = this.activities.get(id)
		if (!activity || !this.canStop(activity)) return false
		activity.info.status = "stopping"
		try {
			activity.process.abort()
		} catch {
			activity.info.status = "unknown"
			this.changed()
			return false
		}
		this.changed()
		return true
	}

	public static showTerminal(id: string): boolean {
		const activity = this.activities.get(id)
		if (!activity || activity.info.provider !== "vscode" || !this.isCurrent(activity)) return false
		// Structural access avoids importing Terminal and introducing a runtime cycle.
		const terminal = activity.terminal as RooTerminal & { terminal?: { show: () => void } }
		if (!terminal.terminal) return false
		try {
			terminal.terminal.show()
			return true
		} catch {
			return false
		}
	}

	public static terminalClosed(terminal: RooTerminal): void {
		for (const activity of this.activities.values()) {
			if (activity.terminal !== terminal) continue
			activity.closed = true
			if (!activity.exited) activity.info.status = "unknown"
			activity.unsubscribe()
		}
		this.changed()
	}

	public static clearCompleted(): void {
		for (const [id, activity] of this.activities) {
			if (activity.info.status === "running" || activity.info.status === "stopping") continue
			activity.unsubscribe()
			this.activities.delete(id)
		}
		this.changed()
	}

	private static changed(): void {
		const history = [...this.activities.values()].filter(
			(a) => a.info.status !== "running" && a.info.status !== "stopping",
		)
		for (const activity of history.slice(0, Math.max(0, history.length - HISTORY_LIMIT))) {
			activity.unsubscribe()
			this.activities.delete(activity.info.id)
		}
		if (this.timer || !this.listeners.size) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			for (const listener of this.listeners) {
				try {
					listener()
				} catch {
					/* A consumer must not interrupt terminal output. */
				}
			}
		}, 250)
	}

	public static dispose(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = undefined
		for (const activity of this.activities.values()) activity.unsubscribe()
		this.activities.clear()
		this.listeners.clear()
		this.identities = new WeakMap()
		this.latest = new WeakMap()
	}
}
