import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import * as path from "node:path"

export function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

export function isWithin(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export async function exists(filename: string): Promise<boolean> {
	try {
		await fs.lstat(filename)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
}

/** Reject links in every existing component, including ancestors above the workspace. */
export async function validatePath(filename: string, secure = false, allowMissing = false): Promise<void> {
	if (!path.isAbsolute(filename) || path.normalize(filename) !== filename)
		throw new Error("Expected canonical absolute path")
	let current = path.parse(filename).root
	for (const component of filename.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component)
		let info
		try {
			info = await fs.lstat(current)
		} catch (error) {
			if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		if (info.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`)
		if (current !== filename && !info.isDirectory()) throw new Error("Non-directory path ancestor")
		if (secure && ((info.mode & 0o022) !== 0 || (info.uid !== 0 && info.uid !== process.getuid!()))) {
			throw new Error(`Insecure managed path ownership or permissions: ${current}`)
		}
	}
}

export async function boundedRead(filename: string, limit: number): Promise<Buffer> {
	const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > limit || before.nlink !== 1) throw new Error("Unsafe or oversized file")
		const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1))
		let offset = 0
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
			if (!bytesRead) break
			offset += bytesRead
		}
		const after = await handle.stat()
		if (
			offset !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		) {
			throw new Error("File changed while reading")
		}
		return buffer.subarray(0, offset)
	} finally {
		await handle.close()
	}
}

export async function hashExecutable(filename: string): Promise<string> {
	await validatePath(filename, true)
	const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		const before = await handle.stat()
		if (!before.isFile() || !(before.mode & 0o111) || before.size > 256 * 1024 * 1024) {
			throw new Error("Configured interpreter must be a bounded executable regular file")
		}
		const hash = createHash("sha256")
		const buffer = Buffer.alloc(64 * 1024)
		let total = 0
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
			if (!bytesRead) break
			total += bytesRead
			if (total > before.size) throw new Error("Interpreter changed while reading")
			hash.update(buffer.subarray(0, bytesRead))
		}
		const after = await handle.stat()
		if (total !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new Error("Interpreter changed while reading")
		}
		return hash.digest("hex")
	} finally {
		await handle.close()
	}
}

/** Observed logical sizes, not an operating-system disk quota. */
export async function directoryBytes(directory: string, limit: number): Promise<number> {
	let bytes = 0
	let count = 0
	async function walk(current: string): Promise<void> {
		for (const item of await fs.readdir(current, { withFileTypes: true })) {
			if (++count > 100_000) throw new Error("Managed directory contains too many entries")
			const filename = path.join(current, item.name)
			const info = await fs.lstat(filename)
			if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
				throw new Error("Unexpected managed directory entry")
			bytes += info.size
			if (bytes > limit) throw new Error("Managed environment disk budget exceeded")
			if (info.isDirectory()) await walk(filename)
		}
	}
	await walk(directory)
	return bytes
}
