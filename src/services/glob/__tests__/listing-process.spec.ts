import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { spawn } from "child_process"
import { ListingProcess, LISTING_PROCESS_SOURCE } from "../listing-process"

vi.mock("child_process", () => ({ spawn: vi.fn() }))
let child: EventEmitter & {
	stdin: PassThrough
	stdout: PassThrough
	stderr: PassThrough
	kill: ReturnType<typeof vi.fn>
	unref: ReturnType<typeof vi.fn>
}
beforeEach(() => {
	vi.useFakeTimers()
	child = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
		unref: vi.fn(),
	})
	vi.mocked(spawn).mockReturnValue(child as never)
})
afterEach(() => {
	child.emit("exit", 0)
	expect(vi.getTimerCount()).toBe(0)
	vi.useRealTimers()
	vi.clearAllMocks()
})
it("starts the existing runtime in Node mode without shell or external files", () => {
	const worker = new ListingProcess()
	expect(spawn).toHaveBeenCalledWith(
		process.execPath,
		["--eval", LISTING_PROCESS_SOURCE],
		expect.objectContaining({
			env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" }),
			windowsHide: true,
		}),
	)
	worker.stop()
})
it("rejects stuck requests, destroys pipes, escalates termination, and ignores late data", async () => {
	const worker = new ListingProcess()
	const pending = worker.request("read")
	const assertion = expect(pending).rejects.toThrow("deadline")
	worker.stop(new Error("deadline"))
	await assertion
	expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM")
	expect(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed).toBe(true)
	expect(child.stdout.listenerCount("data")).toBe(0)
	child.stdout.emit("data", '{"value":["late"]}\n')
	worker.stop()
	await vi.advanceTimersByTimeAsync(250)
	expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]])
	expect(child.unref).toHaveBeenCalledOnce()
	await expect(worker.request("read")).rejects.toThrow("deadline")
})
it("cancels escalation when the child exits and settles an exit/data race only once", async () => {
	const worker = new ListingProcess()
	const pending = worker.request("read")
	child.stdout.emit("data", '{"value":[]}\n')
	child.emit("exit", 0)
	await expect(pending).resolves.toEqual([])
	expect(vi.getTimerCount()).toBe(0)
	expect(child.listenerCount("exit")).toBe(0)
	expect(child.listenerCount("close")).toBe(0)
})
it("handles spawn errors without waiting for the deadline", async () => {
	const worker = new ListingProcess()
	const assertion = expect(worker.request("realpath", "/fixture")).rejects.toThrow("spawn failed")
	child.emit("error", new Error("spawn failed"))
	await assertion
})
it("bounds live children even if the operating system never acknowledges termination", () => {
	const children = Array.from({ length: 4 }, () =>
		Object.assign(new EventEmitter(), {
			stdin: new PassThrough(),
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
			unref: vi.fn(),
		}),
	)
	children.forEach((process) => vi.mocked(spawn).mockReturnValueOnce(process as never))
	const blocked = children.map(() => new ListingProcess())
	blocked.forEach((worker) => worker.stop())
	expect(() => new ListingProcess()).toThrow("still stopping")
	children.forEach((process) => process.emit("exit", 0))
})
