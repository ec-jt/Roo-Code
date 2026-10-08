import * as path from "path"

import { TaskSaveQueue } from "../taskSaveQueue"

function deferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

function harness() {
	const queue = new TaskSaveQueue()
	const writes: { value: unknown; gate: ReturnType<typeof deferred> }[] = []
	const write = vi.fn((value: unknown) => {
		const gate = deferred()
		writes.push({ value, gate })
		return gate.promise
	})
	const save = (value: unknown, kind = "api", barrier = false, taskDirectory = "/tasks/one") =>
		queue.save({ taskDirectory, kind, barrier, snapshot: () => value, write })
	return { queue, writes, write, save }
}

describe("TaskSaveQueue", () => {
	it("keeps one active and the newest pending snapshot, resolving replaced waiters only when durable", async () => {
		const { queue, writes, save } = harness()
		const first = save(1)
		const secondDone = vi.fn()
		const second = save(2).then(secondDone)
		const third = save(3)
		const flushed = queue.flush("/tasks/one")
		expect(writes.map(({ value }) => value)).toEqual([1])
		writes[0].gate.resolve()
		await first
		expect(secondDone).not.toHaveBeenCalled()
		expect(writes.map(({ value }) => value)).toEqual([1, 3])
		writes[1].gate.resolve()
		await Promise.all([second, third, flushed])
		expect(secondDone).toHaveBeenCalledOnce()
		await queue.flush("/tasks/one")
	})

	it("serializes both kinds while retaining the latest of each, and runs unrelated tasks independently", async () => {
		const { writes, save } = harness()
		const results = [save("api-1"), save("ui-1", "ui"), save("api-2"), save("ui-2", "ui")]
		const other = save("other", "ui", false, "/tasks/two")
		expect(writes.map(({ value }) => value)).toEqual(["api-1", "other"])
		writes[1].gate.resolve()
		await other
		writes[0].gate.resolve()
		await results[0]
		expect(writes[2].value).toBe("api-2")
		writes[2].gate.resolve()
		await results[2]
		expect(writes[3].value).toBe("ui-2")
		writes[3].gate.resolve()
		await Promise.all(results)
	})

	it("does not replace a barrier or coalesce pending snapshots across it", async () => {
		const { writes, save } = harness()
		const results = [save(1), save(2), save(3, "ui", true), save(4), save(5)]
		for (const [index, value] of [1, 2, 3, 5].entries()) {
			expect(writes[index].value).toBe(value)
			writes[index].gate.resolve()
			await Promise.resolve()
		}
		await Promise.all(results)
	})

	it("evaluates only surviving default factories and captures barriers immediately", async () => {
		const { queue, writes, write, save } = harness()
		const first = save(0)
		const skipped = vi.fn(() => "skipped")
		const second = queue.save({ taskDirectory: "/tasks/one", kind: "api", snapshot: skipped, write })
		let live = 1
		const selected = vi.fn(() => live)
		const third = queue.save({ taskDirectory: "/tasks/one", kind: "api", snapshot: selected, write })
		const barrier = queue.save({
			taskDirectory: "/tasks/one",
			kind: "ui",
			barrier: true,
			snapshot: () => live,
			write,
		})
		live = 2
		expect(skipped).not.toHaveBeenCalled()
		expect(selected).not.toHaveBeenCalled()
		writes[0].gate.resolve()
		await first
		expect(writes[1].value).toBe(2)
		writes[1].gate.resolve()
		await third
		expect(writes[2].value).toBe(1)
		writes[2].gate.resolve()
		await Promise.all([second, barrier])
		expect(skipped).not.toHaveBeenCalled()
		expect(selected).toHaveBeenCalledOnce()
	})

	it("rejects every replaced waiter and flush on failure, then recovers without unhandled worker rejection", async () => {
		const { queue, writes, save } = harness()
		const first = save(1)
		const second = save(2)
		const third = save(3)
		const flushed = queue.flush("/tasks/one")
		const outcomes = Promise.allSettled([second, third, flushed])
		writes[0].gate.resolve()
		await first
		const error = new Error("disk full")
		writes[1].gate.reject(error)
		expect(await outcomes).toEqual(Array(3).fill({ status: "rejected", reason: error }))
		const recovery = save(4)
		writes[2].gate.resolve()
		await recovery
		await new Promise<void>((resolve) => setImmediate(resolve))
	})

	it("continues pending work after active failure and reports it to flush", async () => {
		const { queue, writes, save } = harness()
		const first = save(1)
		const second = save(2, "ui")
		const flushed = queue.flush("/tasks/one")
		const outcomes = Promise.allSettled([first, flushed])
		const error = new Error("failed active write")
		writes[0].gate.reject(error)
		expect(await outcomes).toEqual(Array(2).fill({ status: "rejected", reason: error }))
		expect(writes[1].value).toBe(2)
		writes[1].gate.resolve()
		await second
	})

	it("rejects synchronous snapshot and writer errors without poisoning the lane", async () => {
		const queue = new TaskSaveQueue()
		const error = new Error("clone failed")
		for (const barrier of [false, true]) {
			await expect(
				queue.save({
					taskDirectory: "/tasks/one",
					kind: "api",
					barrier,
					snapshot: () => {
						throw error
					},
					write: vi.fn(),
				}),
			).rejects.toBe(error)
		}
		await expect(
			queue.save({
				taskDirectory: "/tasks/one",
				kind: "api",
				snapshot: () => 1,
				write: () => {
					throw error
				},
			}),
		).rejects.toBe(error)
		await queue.flush("/tasks/one")
	})

	it("normalizes path aliases and flush waits for newly added writes", async () => {
		const { queue, writes, save } = harness()
		const directory = path.resolve("tasks/one")
		const first = save(1, "api", false, directory)
		const flushedDone = vi.fn()
		const flushed = queue.flush(directory).then(flushedDone)
		const second = save(2, "api", false, "tasks/../tasks/one")
		expect(writes).toHaveLength(1)
		writes[0].gate.resolve()
		await first
		expect(flushedDone).not.toHaveBeenCalled()
		writes[1].gate.resolve()
		await Promise.all([second, flushed])
	})
})
