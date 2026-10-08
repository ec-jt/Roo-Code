import { EventEmitter } from "events"

import { CommandActivity } from "../CommandActivity"
import type { RooTerminal, RooTerminalProcess, RooTerminalProcessEvents } from "../types"

function fixture(provider: "vscode" | "execa" = "vscode") {
	const process = Object.assign(new EventEmitter<RooTerminalProcessEvents>(), {
		command: "",
		isHot: false,
		run: vi.fn(),
		continue: vi.fn(),
		abort: vi.fn(),
		hasUnretrievedOutput: vi.fn(),
		getUnretrievedOutput: vi.fn(),
		trimRetrievedOutput: vi.fn(),
	}) as RooTerminalProcess
	const terminal = {
		id: 1,
		provider,
		taskId: "task-1",
		process,
		running: false,
		busy: true,
		isClosed: vi.fn(() => false),
		getCurrentWorkingDirectory: () => "/workspace",
		terminal: { show: vi.fn() },
	} as unknown as RooTerminal & { terminal: { show: ReturnType<typeof vi.fn> } }
	const id = CommandActivity.register(terminal, process, "echo ready")
	const start = () => {
		terminal.running = true
		process.emit("shell_execution_started", 42)
	}
	return { terminal, process, id, start }
}

describe("CommandActivity", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		CommandActivity.dispose()
	})
	afterEach(() => {
		CommandActivity.dispose()
		vi.useRealTimers()
	})

	it("records explicit commands once and does not mistake output completion for exit", () => {
		const { terminal, process, id, start } = fixture()
		expect(CommandActivity.register(terminal, process, "duplicate")).toBe(id)
		expect(CommandActivity.snapshot()).toEqual([
			expect.objectContaining({
				id,
				command: "echo ready",
				cwd: "/workspace",
				taskId: "task-1",
				status: "running",
				canStop: false,
			}),
		])
		start()
		process.emit("completed", "output ended")
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status: "running", canStop: true })
		expect(CommandActivity.snapshot()[0].endedAt).toBeUndefined()
		process.emit("shell_execution_complete", { exitCode: 0 })
		expect(CommandActivity.snapshot()[0]).toMatchObject({
			status: "completed",
			exitCode: 0,
			canStop: false,
			endedAt: expect.any(Number),
		})
	})

	it.each([
		[{ exitCode: 3 }, "failed"],
		[{ exitCode: undefined, signalName: "SIGKILL" }, "failed"],
		[{ exitCode: undefined }, "unknown"],
	] as const)("uses exit evidence %j for status %s", (details, status) => {
		const { process, start } = fixture("execa")
		start()
		process.emit("shell_execution_complete", details)
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status, canStop: false, canShowTerminal: false })
	})

	it("marks errors without exit proof conservatively", () => {
		const { process, start } = fixture()
		start()
		process.emit("error", new Error("lost connection"))
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status: "unknown", canStop: false })
		expect(CommandActivity.snapshot()[0].endedAt).toBeUndefined()
	})

	it("records startup errors as failed without inventing an exit code", () => {
		const { process } = fixture()
		process.emit("error", new Error("could not start"))
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status: "failed", canStop: false })
		expect(CommandActivity.snapshot()[0].exitCode).toBeUndefined()
	})

	it("disables stop for unavailable shell integration and terminal closure", () => {
		const { terminal, process, start } = fixture()
		start()
		process.emit("no_shell_integration", "unavailable")
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status: "unknown", canStop: false })
		CommandActivity.terminalClosed(terminal)
		expect(CommandActivity.snapshot()[0]).toMatchObject({
			status: "unknown",
			canStop: false,
			canShowTerminal: false,
		})
		expect(CommandActivity.snapshot()[0].endedAt).toBeUndefined()
		expect(process.listenerCount("activity_output")).toBe(0)
	})

	it("keeps captured task ownership after release and refuses stale controls after reuse", () => {
		const { terminal, process, id, start } = fixture()
		start()
		terminal.taskId = undefined
		expect(CommandActivity.snapshot()[0].taskId).toBe("task-1")
		expect(CommandActivity.showTerminal(id)).toBe(true)
		terminal.process = fixture("execa").process
		terminal.taskId = "task-2"
		const next = CommandActivity.register(terminal, terminal.process, "next")
		expect(next).not.toBe(id)
		expect(CommandActivity.stop(id)).toBe(false)
		expect(CommandActivity.showTerminal(id)).toBe(false)
		expect(process.abort).not.toHaveBeenCalled()
	})

	it("requests abort once and waits for exit proof", () => {
		const { process, id, start } = fixture()
		start()
		expect(CommandActivity.stop(id)).toBe(true)
		expect(CommandActivity.stop(id)).toBe(false)
		expect(process.abort).toHaveBeenCalledTimes(1)
		expect(CommandActivity.snapshot()[0]).toMatchObject({ status: "stopping", canStop: false })
		expect(CommandActivity.snapshot()[0].endedAt).toBeUndefined()
		process.emit("shell_execution_complete", { exitCode: 130 })
		expect(CommandActivity.snapshot()[0].status).toBe("failed")
	})

	it("captures output after continue without consuming model buffers", () => {
		const { process } = fixture()
		process.on("line", vi.fn())
		process.removeAllListeners("line")
		process.emit("continue")
		process.emit("activity_output", "first\n")
		process.emit("activity_output", "second\n")
		expect(CommandActivity.snapshot()[0].outputTail).toBe("first\nsecond\n")
		expect(process.getUnretrievedOutput).not.toHaveBeenCalled()
	})

	it("strips split ANSI/control sequences, redacts recognizable credentials, and bounds UTF-8 tails", () => {
		const { process } = fixture()
		process.emit("activity_output", "\x1b[3")
		process.emit("activity_output", "1mred\x1b[0m\x1b]633;")
		process.emit("activity_output", "D;0\x07\x00\nAuthorization: Bearer secret-value\napi_key=abc\n")
		expect(CommandActivity.snapshot()[0].outputTail).toBe("red\nAuthorization: [redacted]\napi_key=[redacted]\n")
		process.emit("activity_output", "é".repeat(9000))
		const tail = CommandActivity.snapshot()[0].outputTail
		expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(8192)
		expect(tail).not.toContain("�")
	})

	it("keeps running entries and at most 50 history entries", () => {
		const active = fixture()
		for (let i = 0; i < 60; i++) {
			const { process } = fixture()
			process.emit("shell_execution_complete", { exitCode: 0 })
		}
		expect(CommandActivity.snapshot()).toHaveLength(51)
		expect(CommandActivity.snapshot().some((info) => info.id === active.id)).toBe(true)
		CommandActivity.clearCompleted()
		expect(CommandActivity.snapshot()).toHaveLength(1)
	})

	it("throttles notifications, isolates consumers, and cleans only its own listeners", () => {
		const subscriber = vi.fn()
		const unsubscribe = CommandActivity.onChange(subscriber)
		CommandActivity.onChange(() => {
			throw new Error("consumer error")
		})
		const { process } = fixture()
		const external = vi.fn()
		process.on("activity_output", external)
		for (let i = 0; i < 100; i++) process.emit("activity_output", "data")
		expect(subscriber).not.toHaveBeenCalled()
		vi.advanceTimersByTime(250)
		expect(subscriber).toHaveBeenCalledTimes(1)
		unsubscribe()
		process.emit("activity_output", "last")
		CommandActivity.dispose()
		vi.advanceTimersByTime(1000)
		expect(subscriber).toHaveBeenCalledTimes(1)
		expect(process.listeners("activity_output")).toEqual([external])
		expect(CommandActivity.snapshot()).toEqual([])
	})
})
