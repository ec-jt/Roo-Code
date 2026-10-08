import { constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import * as lockfile from "proper-lockfile"
import { MemoryError } from "./types"

export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT"

/** Check every ancestor; never traverse a symlink, including the configured storage root. */
export async function directory(target: string, create = false): Promise<boolean> {
	const absolute = path.resolve(target)
	let current = path.parse(absolute).root
	for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		let stat
		try {
			stat = await fs.lstat(current)
		} catch (error) {
			if (!missing(error)) throw error
			if (!create) return false
			try {
				await fs.mkdir(current, { mode: 0o700 })
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
			}
			stat = await fs.lstat(current)
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new MemoryError("UNSAFE_PATH", "Memory directories must be real directories, not symbolic links")
		}
	}
	return true
}

export async function regularFile(file: string): Promise<void> {
	try {
		const stat = await fs.lstat(file)
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw new MemoryError("UNSAFE_FILE", "Memory files must be regular files with one link")
		}
	} catch (error) {
		if (!missing(error)) throw error
	}
}

/** lstat before open avoids FIFO hangs. NOFOLLOW/NONBLOCK and fstat also check replacement races. */
export async function readText(file: string, maxBytes: number): Promise<string | undefined> {
	if (!(await directory(path.dirname(file)))) return undefined
	let before
	try {
		before = await fs.lstat(file)
	} catch (error) {
		if (missing(error)) return undefined
		throw error
	}
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new MemoryError("UNSAFE_FILE", "Memory files must be regular files with one link")
	}
	if (before.size > maxBytes) throw new MemoryError("LIMIT", "Memory file exceeds its byte limit")
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev) {
			throw new MemoryError("UNSAFE_FILE", "Memory file changed during open")
		}
		const buffer = Buffer.alloc(maxBytes + 1)
		let offset = 0
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
			if (!bytesRead) break
			offset += bytesRead
		}
		if (offset > maxBytes) throw new MemoryError("LIMIT", "Memory file exceeds its byte limit")
		const after = await handle.stat()
		if (after.nlink !== 1 || after.size !== offset || after.mtimeMs !== opened.mtimeMs) {
			throw new MemoryError("CONFLICT", "Memory file changed during read; retry")
		}
		try {
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset))
		} catch {
			throw new MemoryError("INVALID_RECORD", "Memory files must contain valid UTF-8")
		}
	} finally {
		await handle.close()
	}
}

/** Text only. JSON persistence must instead use the project's safeWriteJson utility. */
export async function atomicText(file: string, text: string, expected: string | null, maxBytes: number): Promise<void> {
	await directory(path.dirname(file), true)
	const temp = path.join(path.dirname(file), `.memory-${randomUUID()}.tmp`)
	const handle = await fs.open(
		temp,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		0o600,
	)
	try {
		await handle.writeFile(text, "utf8")
		await handle.sync()
		await handle.close()
		await directory(path.dirname(file))
		const current = await readText(file, maxBytes)
		if ((current === undefined ? null : hash(current)) !== expected) {
			throw new MemoryError("CONFLICT", "Memory file changed before commit; reread before retrying")
		}
		await fs.rename(temp, file)
	} finally {
		await handle.close().catch(() => undefined)
		await fs.unlink(temp).catch((error) => {
			if (!missing(error)) throw error
		})
	}
}

export async function locked<T>(target: string, operation: (assertLock: () => void) => Promise<T>): Promise<T> {
	await directory(path.dirname(target), true)
	await directory(`${target}.lock`)
	let compromised = false
	const release = await lockfile.lock(target, {
		realpath: false,
		stale: 31_000,
		update: 10_000,
		retries: { retries: 30, minTimeout: 50, maxTimeout: 500, factor: 1.2 },
		onCompromised: () => {
			compromised = true
		},
	})
	try {
		return await operation(() => {
			if (compromised) throw new MemoryError("LOCK_LOST", "Memory lock was lost; operation cancelled")
		})
	} finally {
		await release()
	}
}
