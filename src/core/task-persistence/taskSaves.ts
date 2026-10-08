import * as fs from "fs/promises"
import * as path from "path"

import { safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"
import { TaskSaveQueue } from "../../utils/taskSaveQueue"

export type TaskSaveOptions = {
	taskId: string
	globalStoragePath: string
	/** Persist this exact snapshot, without replacement by another save. */
	barrier?: boolean
}

const saves = new TaskSaveQueue()
// Resolve and admit requests in invocation order, but do not wait for writes here.
// This also prevents flush from overtaking a save still resolving its storage path.
let admission = Promise.resolve()

type SubmittedSave = {
	inputKey: string
	directory?: string
	result: Promise<{ error: unknown } | undefined>
}
const submitted = new Set<SubmittedSave>()

function inputKey(options: TaskSaveOptions): string {
	return path.resolve(options.globalStoragePath, "tasks", options.taskId)
}

async function canonicalPath(target: string): Promise<string> {
	try {
		return await fs.realpath(target)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		const parent = path.dirname(target)
		if (parent === target) throw error
		return path.join(await canonicalPath(parent), path.basename(target))
	}
}

function atTaskPath(options: TaskSaveOptions, operation: (directory: string) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		admission = admission.then(async () => {
			try {
				const base = await getStorageBasePath(options.globalStoragePath)
				const directory = await canonicalPath(path.resolve(base, "tasks", options.taskId))
				operation(directory).then(resolve, reject)
			} catch (error) {
				reject(error)
			}
		})
	})
}

/** Snapshot factories must return owned data, not a mutable live message array. */
export function saveTaskSnapshot(options: TaskSaveOptions, fileName: string, snapshot: () => unknown): Promise<void> {
	// Capture exact barriers before even resolving the storage path.
	if (options.barrier) {
		try {
			const captured = snapshot()
			snapshot = () => captured
		} catch (error) {
			return Promise.reject(error)
		}
	}
	const entry: SubmittedSave = { inputKey: inputKey(options), result: Promise.resolve(undefined) }
	const result = atTaskPath(options, (directory) => {
		entry.directory = directory
		return saves.save({
			taskDirectory: directory,
			kind: fileName,
			barrier: options.barrier,
			snapshot,
			write: (data) => safeWriteJson(path.join(directory, fileName), data),
		})
	})
	// Observe completion immediately, so flush can report a failure even if path
	// resolution finishes after the failed write has already left its lane.
	entry.result = result.then(
		() => {
			submitted.delete(entry)
			return undefined
		},
		(error: unknown) => {
			submitted.delete(entry)
			return { error }
		},
	)
	submitted.add(entry)
	return result
}

/** Drain previously submitted API and UI saves. Callers must stop producers before deleting or disposing a task. */
export function flushTaskSaves(options: Omit<TaskSaveOptions, "barrier">): Promise<void> {
	const preceding = [...submitted]
	return atTaskPath(options, async (directory) => {
		const relevant = preceding.filter(
			(entry) => entry.directory === directory || (!entry.directory && entry.inputKey === inputKey(options)),
		)
		await Promise.all([
			saves.flush(directory),
			...relevant.map(async (entry) => {
				const failure = await entry.result
				if (failure) throw failure.error
			}),
		])
	})
}
