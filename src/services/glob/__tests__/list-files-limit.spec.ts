import path from "node:path"
import { listFiles } from "../list-files"
import { ListingProcess } from "../listing-process"

vi.mock("../listing-process", () => ({ ListingProcess: vi.fn() }))
let request: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>
let rejectPending: ((error: Error) => void) | undefined
const root = path.resolve("/fixture")
const entry = (name: string, directory = false) => ({ name, directory, symlink: false })
beforeEach(() => {
	vi.useFakeTimers()
	rejectPending = undefined
	request = vi.fn(async (operation, filename) => {
		if (operation === "realpath") return filename
		if (operation === "ignore") return ""
		if (operation === "read") return []
		return true
	})
	stop = vi.fn((error) => rejectPending?.(error ?? new Error("stopped")))
	vi.mocked(ListingProcess).mockImplementation(() => ({ request, stop }) as unknown as ListingProcess)
})
afterEach(() => {
	expect(vi.getTimerCount()).toBe(0)
	vi.useRealTimers()
	vi.clearAllMocks()
})
it("caps huge entry streams and does not descend before returning direct entries", async () => {
	request.mockImplementation(async (operation, filename) =>
		operation === "realpath"
			? filename
			: operation === "ignore"
				? ""
				: operation === "read"
					? Array.from({ length: 32 }, (_, i) => entry(`dir${i}`, true))
					: true,
	)
	const result = await listFiles(root, true, 10)
	expect(result[0]).toHaveLength(10)
	expect(result[1]).toBe(true)
	expect(request.mock.calls.filter(([op]) => op === "open")).toHaveLength(1)
	expect(request.mock.calls.filter(([op]) => op === "read")).toHaveLength(1)
})
it("bounds work even when every discovered entry is ignored", async () => {
	request.mockImplementation(async (operation, filename) =>
		operation === "realpath"
			? filename
			: operation === "ignore"
				? "ignored*"
				: operation === "read"
					? Array.from({ length: 32 }, (_, i) => entry(`ignored${i}`))
					: true,
	)
	const result = await listFiles(root, true, 100, { maxEntries: 50 })
	expect(result[0]).toHaveLength(0)
	expect(result.reason).toContain("entry-work budget")
	expect(request.mock.calls.filter(([op]) => op === "read")).toHaveLength(2)
})
it("bounds depth without recursive call stacks", async () => {
	request.mockImplementation(async (operation, filename) =>
		operation === "realpath"
			? filename
			: operation === "ignore"
				? ""
				: operation === "read"
					? [entry("child", true)]
					: true,
	)
	const result = await listFiles(root, true, 100, { maxDepth: 2 })
	expect(result[0]).toHaveLength(3)
	expect(result.reason).toContain("depth budget")
})
it.each(["realpath", "ignore", "open", "read"])("the global deadline stops a stuck %s operation", async (stalled) => {
	const fallback = request.getMockImplementation()!
	request.mockImplementation((op, filename) =>
		op === stalled
			? new Promise((_, reject) => {
					rejectPending = reject
				})
			: fallback(op, filename),
	)
	const pending = listFiles(root, true, 100, { timeoutMs: 20 })
	const assertion = expect(pending).rejects.toThrow("timed out")
	await vi.advanceTimersByTimeAsync(20)
	await assertion
	expect(stop).toHaveBeenCalled()
	const count = request.mock.calls.length
	await vi.advanceTimersByTimeAsync(1000)
	expect(request).toHaveBeenCalledTimes(count)
})
it("uses one deadline across stages, not a fresh timeout per request", async () => {
	request.mockImplementation(
		(operation, filename) =>
			new Promise((resolve, reject) => {
				rejectPending = reject
				setTimeout(() => resolve(operation === "realpath" ? filename : ""), 8)
			}),
	)
	const assertion = expect(listFiles(root, true, 100, { timeoutMs: 20 })).rejects.toThrow("timed out")
	await vi.advanceTimersByTimeAsync(30)
	await assertion
})
it("returns partial results with a reason after a disappearing child", async () => {
	let opened = 0
	request.mockImplementation(async (operation, filename) => {
		if (operation === "realpath") return filename
		if (operation === "ignore") return ""
		if (operation === "open" && ++opened > 1) throw new Error("ENOENT")
		return operation === "read" ? [entry("child", true)] : true
	})
	const result = await listFiles(root, true, 100)
	expect(result[0]).toEqual([path.join(root, "child") + "/"])
	expect(result.reason).toContain("disappeared")
})
it("propagates cancellation and stops the child without scheduling more work", async () => {
	request.mockImplementation(
		() =>
			new Promise((_, reject) => {
				rejectPending = reject
			}),
	)
	const controller = new AbortController()
	const assertion = expect(listFiles(root, true, 100, { signal: controller.signal })).rejects.toThrow("cancelled")
	controller.abort(new Error("cancelled"))
	await assertion
	expect(request).toHaveBeenCalledTimes(1)
	expect(stop).toHaveBeenCalled()
})
it("restricts recursive virtual filesystem scans to direct entries without reading contents", async () => {
	request.mockImplementation(async (operation) =>
		operation === "realpath" ? "/proc" : operation === "read" ? [entry("self", false), entry("123", true)] : true,
	)
	const result = await listFiles(root, true, 100)
	expect(result.reason).toContain("only direct entries")
	expect(request.mock.calls.filter(([op]) => op === "open")).toHaveLength(1)
	expect(request.mock.calls.some(([op]) => op === "ignore")).toBe(false)
})

it("labels partial results when a later directory stalls", async () => {
	let opens = 0
	request.mockImplementation(async (operation, filename) => {
		if (operation === "realpath") return filename
		if (operation === "ignore") return ""
		if (operation === "open" && ++opens > 1)
			return new Promise((_, reject) => {
				rejectPending = reject
			})
		return operation === "read" ? [entry("child", true)] : true
	})
	const pending = listFiles(root, true, 100, { timeoutMs: 20 })
	await vi.advanceTimersByTimeAsync(20)
	const result = await pending
	expect(result[0]).toEqual([path.join(root, "child") + "/"])
	expect(result.reason).toContain("timed out")
	expect(result[1]).toBe(true)
})
