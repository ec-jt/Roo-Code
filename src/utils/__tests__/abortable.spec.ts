import { getEventListeners } from "node:events"

import { abortable } from "../abortable"

describe("abortable", () => {
	it("keeps listener count bounded across the first chunk and more than 100 remaining chunks", async () => {
		const controller = new AbortController()
		const { signal } = controller
		const unrelated = vi.fn()
		signal.addEventListener("abort", unrelated)
		let chunk = 0
		const iterator = {
			next: vi.fn(async () => {
				expect(getEventListeners(signal, "abort")).toHaveLength(2)
				return { value: chunk++, done: chunk > 250 }
			}),
		}

		for (let index = 0; index <= 250; index++) {
			const result = await abortable(signal, () => iterator.next(), "cancelled")
			expect(result).toEqual({ value: index, done: index === 250 })
			expect(getEventListeners(signal, "abort")).toEqual([unrelated])
		}
		expect(iterator.next).toHaveBeenCalledTimes(251)
		expect(unrelated).not.toHaveBeenCalled()
	})

	it.each(["synchronous", "asynchronous"])("cleans up after a %s iterator failure", async (kind) => {
		const { signal } = new AbortController()
		const error = new Error("provider failed")
		const next = () => {
			if (kind === "synchronous") throw error
			return Promise.reject(error)
		}

		await expect(abortable(signal, next, "cancelled")).rejects.toBe(error)
		expect(getEventListeners(signal, "abort")).toHaveLength(0)
	})

	it("does not start an iterator after cancellation", async () => {
		const controller = new AbortController()
		controller.abort()
		const next = vi.fn()

		await expect(abortable(controller.signal, next, "Request dispatch fenced")).rejects.toThrow(
			"Request dispatch fenced",
		)
		expect(next).not.toHaveBeenCalled()
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it("cleans up on cancellation even when the iterator never settles", async () => {
		const controller = new AbortController()
		const pending = abortable(controller.signal, () => new Promise<never>(() => {}), "cancelled")
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
		controller.abort()

		await expect(pending).rejects.toThrow("cancelled")
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it("observes a late iterator rejection after cancellation", async () => {
		const controller = new AbortController()
		let reject!: (error: Error) => void
		const pending = abortable(
			controller.signal,
			() => new Promise<never>((_, fail) => (reject = fail)),
			"cancelled",
		)
		controller.abort()
		await expect(pending).rejects.toThrow("cancelled")
		reject(new Error("late provider failure"))
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})

	it("observes cancellation when starting the iterator also throws", async () => {
		const controller = new AbortController()
		const error = new Error("provider failed")
		const pending = abortable(
			controller.signal,
			() => {
				controller.abort()
				throw error
			},
			"cancelled",
		)

		await expect(pending).rejects.toBe(error)
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
	})
})
