import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { safeWriteJson } from "../../../utils/safeWriteJson"

// Stable JSON detaches caller data and makes identity independent of insertion
// order. JSON.stringify is for canonicalization only, never filesystem writes.
export function canonicalJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
	if (depth > 100) throw new Error("Model-operation record exceeds JSON nesting limit")
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
	if (typeof value !== "object" || value === null) throw new Error("Model-operation record must be plain JSON")
	if (ancestors.has(value)) throw new Error("Model-operation record contains a cycle")
	ancestors.add(value)
	try {
		const keys = Reflect.ownKeys(value)
		const get = (key: string): unknown => {
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				throw new Error("Model-operation record contains an accessor or non-enumerable field")
			}
			return descriptor.value
		}
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || keys.length !== value.length + 1) {
				throw new Error("Model-operation record contains a non-plain array")
			}
			return `[${Array.from({ length: value.length }, (_, i) => canonicalJson(get(String(i)), ancestors, depth + 1)).join(",")}]`
		}
		const prototype = Object.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null)
			throw new Error("Model-operation record must be plain JSON")
		const fields: string[] = []
		for (const key of keys.sort()) {
			if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") {
				throw new Error("Model-operation record contains an unsafe key")
			}
			const item = get(key)
			if (item !== undefined) fields.push(`${JSON.stringify(key)}:${canonicalJson(item, ancestors, depth + 1)}`)
		}
		return `{${fields.join(",")}}`
	} finally {
		ancestors.delete(value)
	}
}

export function hashJson(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code
}

// The root is trusted. This does not sandbox hostile concurrent directory replacement.
export async function assertNoSymlinks(root: string, filePath: string): Promise<void> {
	let current = path.resolve(root)
	for (const part of path.relative(current, filePath).split(path.sep)) {
		current = path.join(current, part)
		try {
			if ((await fs.lstat(current)).isSymbolicLink())
				throw new Error("Model-operation storage cannot contain symlinks")
		} catch (error) {
			if (hasCode(error, "ENOENT")) return
			throw error
		}
	}
}

/** Bound allocation before reading; reject special files and concurrent size changes. */
export async function readJsonFile(
	root: string,
	filePath: string,
	maxBytes: number,
): Promise<{ value: unknown; bytes: number } | undefined> {
	await assertNoSymlinks(root, filePath)
	let before: Awaited<ReturnType<typeof fs.lstat>>
	try {
		before = await fs.lstat(filePath)
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined
		throw error
	}
	if (!before.isFile()) throw new Error("Model-operation record must be a regular file")
	if (before.size > maxBytes) throw new Error("Model-operation record size limit exceeded")
	const handle = await fs.open(filePath, "r")
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
			throw new Error("Model-operation record changed during read")
		const buffer = Buffer.alloc(before.size)
		let offset = 0
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset)
			if (!bytesRead) throw new Error("Model-operation record changed during read")
			offset += bytesRead
		}
		const extra = await handle.read(Buffer.alloc(1), 0, 1, offset)
		const after = await handle.stat()
		// Publishing/removing staging hard links changes ctime without changing
		// bytes. Do not reject a concurrent immutable winner for that metadata change.
		if (extra.bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
			throw new Error("Model-operation record changed during read")
		return { value: JSON.parse(buffer.toString("utf8")), bytes: buffer.length }
	} finally {
		await handle.close()
	}
}

export async function syncFile(filePath: string): Promise<void> {
	// FlushFileBuffers needs writable regular-file handles on Windows. POSIX
	// directories need read handles; Windows directory fsync is not supported.
	const isDirectory = (await fs.lstat(filePath)).isDirectory()
	const handle = await fs.open(filePath, isDirectory ? "r" : "r+")
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

export async function syncPublishedRecord(root: string, filePath: string): Promise<void> {
	// Re-establish durability after a concurrent winner or a crash after link().
	await syncFile(filePath)
	if (process.platform === "win32") return
	const storageRoot = path.resolve(root)
	let directory = path.dirname(filePath)
	while (true) {
		await syncFile(directory)
		if (directory === storageRoot) break
		directory = path.dirname(directory)
	}
}

/** Caller validates existing bytes and identity. No overwrite, even across processes. */
export async function publishImmutableJson(
	root: string,
	filePath: string,
	value: unknown,
	verifyExisting: () => Promise<boolean>,
): Promise<void> {
	await assertNoSymlinks(root, filePath)
	if (await verifyExisting()) {
		await syncPublishedRecord(root, filePath)
		return
	}
	const stagingPath = path.join(path.dirname(filePath), `.pending-${randomUUID()}.json`)
	try {
		// safeWriteJson creates parents. Never write to the immutable target itself.
		await safeWriteJson(stagingPath, value)
		await syncFile(stagingPath)
		await assertNoSymlinks(root, filePath)
		try {
			await fs.link(stagingPath, filePath)
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error
			if (!(await verifyExisting())) throw new Error("Immutable model-operation record disappeared")
		}
		await syncPublishedRecord(root, filePath)
	} finally {
		await fs.rm(stagingPath, { force: true })
	}
}
