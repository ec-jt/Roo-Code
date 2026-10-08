import * as path from "path"

type Completion = {
	resolve: () => void
	reject: (error: unknown) => void
}

type Save = {
	kind: string
	barrier: boolean
	snapshot: () => unknown
	write: (snapshot: unknown) => Promise<void>
	waiters: Completion[]
}

type Lane = {
	active?: Save
	pending: Save[]
	flushes: Set<Completion>
}

/** Serializes each task's writes, retaining only the newest pending snapshot per kind and barrier segment. */
export class TaskSaveQueue {
	private readonly lanes = new Map<string, Lane>()

	save({
		taskDirectory,
		kind,
		snapshot,
		write,
		barrier = false,
	}: {
		taskDirectory: string
		kind: string
		/** Return an owned, stable snapshot. Default factories run only when the write starts. */
		snapshot: () => unknown
		write: (snapshot: unknown) => Promise<void>
		/** Capture now and prevent coalescing across this exact save. */
		barrier?: boolean
	}): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			// A barrier must freeze its input before any asynchronous work or subsequent mutation.
			if (barrier) {
				const captured = snapshot()
				snapshot = () => captured
			}
			const key = path.resolve(taskDirectory)
			let lane = this.lanes.get(key)
			if (!lane) {
				lane = { pending: [], flushes: new Set() }
				this.lanes.set(key, lane)
			}
			const save: Save = { kind, barrier, snapshot, write, waiters: [{ resolve, reject }] }
			if (!barrier) {
				for (let index = lane.pending.length - 1; index >= 0; index--) {
					const previous = lane.pending[index]
					if (previous.barrier) break
					if (previous.kind === kind) {
						previous.waiters.push({ resolve, reject })
						save.waiters = previous.waiters
						lane.pending.splice(index, 1)
						break
					}
				}
			}
			lane.pending.push(save)
			if (!lane.active) void this.drain(key, lane)
		})
	}

	/** Wait until this lane is idle, including saves added while draining. Reject on any intervening failure. */
	flush(taskDirectory: string): Promise<void> {
		const lane = this.lanes.get(path.resolve(taskDirectory))
		if (!lane) return Promise.resolve()
		return new Promise<void>((resolve, reject) => lane.flushes.add({ resolve, reject }))
	}

	private async drain(key: string, lane: Lane): Promise<void> {
		while (lane.pending.length > 0) {
			const save = lane.pending.shift()!
			lane.active = save
			try {
				await save.write(save.snapshot())
				for (const waiter of save.waiters) waiter.resolve()
			} catch (error) {
				for (const waiter of save.waiters) waiter.reject(error)
				for (const flush of lane.flushes) flush.reject(error)
				lane.flushes.clear()
			}
			lane.active = undefined
		}
		this.lanes.delete(key)
		for (const flush of lane.flushes) flush.resolve()
	}
}
