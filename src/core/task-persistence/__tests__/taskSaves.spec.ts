import * as path from "path"

const mocks = vi.hoisted(() => ({
	write: vi.fn(),
	storage: vi.fn(async (directory: string) => directory),
	realpath: vi.fn(async (directory: string) => directory.replace("/alias/", "/real/")),
}))
vi.mock("../../../utils/safeWriteJson", () => ({ safeWriteJson: mocks.write }))
vi.mock("../../../utils/storage", () => ({ getStorageBasePath: mocks.storage }))
vi.mock("fs/promises", () => ({ realpath: mocks.realpath }))

import { saveApiMessages, saveApiMessagesFromSnapshot } from "../apiMessages"
import { saveTaskMessages, saveTaskMessagesFromSnapshot } from "../taskMessages"
import { flushTaskSaves } from "../taskSaves"

const options = { taskId: "task", globalStoragePath: "/real/storage" }
const api = (content: string) => [{ role: "user" as const, content }]
const ui = (text: string) => [{ ts: 1, type: "say" as const, say: "text" as const, text }]

function deferred() {
	let resolve!: () => void
	let reject!: (error: unknown) => void
	const promise = new Promise<void>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

async function admitted(count: number) {
	await vi.waitFor(() => expect(mocks.realpath).toHaveBeenCalledTimes(count))
	await new Promise<void>((resolve) => setImmediate(resolve))
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.write.mockReset().mockResolvedValue(undefined)
	mocks.storage.mockImplementation(async (directory: string) => directory)
})

describe("task persistence save admission", () => {
	it("captures mutable array inputs before path resolution and preserves the file format", async () => {
		const messages = api("before")
		const saved = saveApiMessages({ ...options, messages })
		messages[0].content = "after"
		messages.push(...api("added"))
		await saved
		expect(mocks.write).toHaveBeenCalledWith(
			path.join(options.globalStoragePath, "tasks", options.taskId, "api_conversation_history.json"),
			api("before"),
		)
	})

	it("coalesces lazy factories across API/UI entrypoints and canonical path aliases", async () => {
		const active = deferred()
		mocks.write.mockImplementationOnce(() => active.promise)
		const first = saveApiMessages({ ...options, messages: api("first") })
		await admitted(1)
		const superseded = vi.fn(() => api("skip"))
		const second = saveApiMessagesFromSnapshot({ ...options, snapshot: superseded })
		const uiMessages = ui("pending")
		const third = saveTaskMessages({ ...options, messages: uiMessages })
		uiMessages[0].text = "mutated"
		const live = api("latest")
		const fourth = saveApiMessagesFromSnapshot({
			...options,
			globalStoragePath: "/alias/storage",
			snapshot: () => live,
		})
		const flushed = flushTaskSaves(options)
		await admitted(5)
		expect(mocks.write).toHaveBeenCalledTimes(1)
		expect(superseded).not.toHaveBeenCalled()
		active.resolve()
		await Promise.all([first, second, third, fourth, flushed])
		expect(mocks.write.mock.calls.map(([, value]) => value)).toEqual([api("first"), ui("pending"), api("latest")])
		expect(superseded).not.toHaveBeenCalled()
	})

	it("freezes strict factory snapshots immediately and prevents replacement on both sides", async () => {
		const active = deferred()
		mocks.write.mockImplementationOnce(() => active.promise)
		const first = saveTaskMessages({ ...options, messages: ui("first") })
		await admitted(1)
		const before = saveTaskMessagesFromSnapshot({ ...options, snapshot: () => ui("before") })
		const live = ui("boundary")
		const strict = saveTaskMessagesFromSnapshot({ ...options, barrier: true, snapshot: () => live })
		live[0].text = "after"
		const after = saveTaskMessagesFromSnapshot({ ...options, snapshot: () => live })
		await admitted(4)
		active.resolve()
		await Promise.all([first, before, strict, after])
		expect(mocks.write.mock.calls.map(([, value]) => value)).toEqual([
			ui("first"),
			ui("before"),
			ui("boundary"),
			ui("after"),
		])
	})

	it("flush observes a save submitted before its path has resolved", async () => {
		const pathReady = deferred()
		const written = deferred()
		mocks.storage.mockImplementationOnce(async (directory: string) => {
			await pathReady.promise
			return directory
		})
		mocks.write.mockImplementationOnce(() => written.promise)
		const save = saveApiMessages({ ...options, messages: api("first") })
		const done = vi.fn()
		const flush = flushTaskSaves(options).then(done)
		await Promise.resolve()
		expect(done).not.toHaveBeenCalled()
		pathReady.resolve()
		await admitted(2)
		expect(done).not.toHaveBeenCalled()
		written.resolve()
		await Promise.all([save, flush])
	})

	it("flush reports an immediate write failure even while resolving its own path", async () => {
		const error = new Error("disk failure")
		mocks.write.mockRejectedValueOnce(error)
		const save = saveApiMessages({ ...options, messages: api("first") })
		const flush = flushTaskSaves(options)
		expect(await Promise.allSettled([save, flush])).toEqual(Array(2).fill({ status: "rejected", reason: error }))
		await saveTaskMessages({ ...options, messages: ui("recovered") })
		await flushTaskSaves(options)
	})

	it("flush reports failed storage resolution and admission recovers", async () => {
		const error = new Error("storage unavailable")
		mocks.storage.mockRejectedValueOnce(error)
		const save = saveApiMessages({ ...options, messages: api("first") })
		const flush = flushTaskSaves(options)
		expect(await Promise.allSettled([save, flush])).toEqual(Array(2).fill({ status: "rejected", reason: error }))
		await saveApiMessages({ ...options, messages: api("recovered") })
	})
})
