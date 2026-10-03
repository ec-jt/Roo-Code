import { createHash, randomUUID } from "node:crypto"
import type { Stats } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"

import { clineMessageSchema, type ClineMessage } from "@roo-code/types"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import { safeWriteJson } from "../../../utils/safeWriteJson"

/**
 * Capture immediately BEFORE dispatch, using the effective API history, not the
 * full persisted history containing hidden/condensed messages. API history must
 * end with the user input (including completed tool results), never its response.
 * UI history may end with this request's api_req_started marker, but no response.
 * The caller is responsible for selecting the exact prefix: untagged old UI rows
 * cannot be attributed retrospectively. This module does not infer boundaries.
 */
export type RequestSnapshot = {
	version: 1
	taskId: string
	requestId: string
	createdAt: number
	apiMessages: ApiMessage[]
	clineMessages: ClineMessage[]
	systemPrompt: string
	sourceProvider?: string
	sourceModelId?: string
}

/** Mandatory approval policy, not a persisted grant of approval for any tool. */
export type BranchProvenance = {
	version: 1
	operationId: string
	kind: "regenerate" | "switch"
	sourceTaskId: string
	sourceRequestId: string
	targetProfileId: string
	createdAt: number
	workspacePath: string
	requiresToolApproval: true
	/** Present only after branch-local replay data and command artifacts are durable. */
	replaySnapshotRequestId?: string
}

const pathIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
	.refine((id) => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id), "Reserved filesystem name")
const timestampSchema = z.number().int().nonnegative().safe()
const identitySchema = z.string().refine((id) => id.trim().length > 0, "Identity must not be blank")
const apiMessageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.union([z.string(), z.array(z.object({ type: z.string().min(1) }).passthrough())]),
	})
	.passthrough()
const snapshotSchema = z
	.object({
		version: z.literal(1),
		taskId: pathIdSchema,
		requestId: pathIdSchema,
		createdAt: timestampSchema,
		apiMessages: z.array(apiMessageSchema).min(1),
		clineMessages: z.array(clineMessageSchema.passthrough()),
		systemPrompt: z.string(),
		sourceProvider: identitySchema.optional(),
		sourceModelId: identitySchema.optional(),
	})
	.strict()
const provenanceSchema = z
	.object({
		version: z.literal(1),
		operationId: identitySchema,
		kind: z.enum(["regenerate", "switch"]),
		sourceTaskId: pathIdSchema,
		sourceRequestId: pathIdSchema,
		targetProfileId: identitySchema,
		createdAt: timestampSchema,
		workspacePath: z.string().min(1).refine(path.isAbsolute, "Workspace path must be absolute"),
		requiresToolApproval: z.literal(true),
		replaySnapshotRequestId: pathIdSchema.optional(),
	})
	.strict()
	.refine(
		(value) =>
			value.replaySnapshotRequestId === undefined || value.replaySnapshotRequestId === value.sourceRequestId,
		"Branch replay snapshot must identify the source request",
	)
const envelopeSchema = z
	.object({
		version: z.literal(1),
		recordType: z.enum(["requestSnapshot", "branchProvenance"]),
		taskId: pathIdSchema,
		requestId: pathIdSchema.optional(),
		checksum: z.string().regex(/^[a-f0-9]{64}$/),
		payload: z.unknown(),
	})
	.strict()
type Envelope = z.infer<typeof envelopeSchema>

// Stable JSON both detaches caller-owned data before the first await and makes
// retries insensitive to object insertion order. JSON.stringify is only used for
// canonicalization/hashing; ALL JSON file writes go through safeWriteJson.
// Inputs must be passive plain data, not hostile proxies. Undefined object fields
// are omitted like JSON; other lossy values, accessors and cycles are rejected.
function canonicalJson(value: unknown, ancestors = new Set<object>(), depth = 0): string {
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

function digest(record: Omit<Envelope, "checksum">): string {
	return createHash("sha256").update(canonicalJson(record)).digest("hex")
}

function validateSnapshot(payload: unknown): RequestSnapshot {
	const snapshot = snapshotSchema.parse(payload)
	if (snapshot.apiMessages.at(-1)?.role !== "user") {
		throw new Error("Request snapshot must end before the assistant response")
	}
	for (const [index, message] of snapshot.clineMessages.entries()) {
		if (message.requestId === snapshot.requestId) {
			if (
				message.type !== "say" ||
				message.say !== "api_req_started" ||
				index !== snapshot.clineMessages.length - 1
			) {
				throw new Error("Request snapshot UI prefix contains this request's response")
			}
		}
	}
	// Block payloads are retained losslessly here. Provider-neutral compatibility,
	// including complete tool pairs, is checked by normalizeSnapshotMessages before use.
	// Validation may strip nested UI extension fields. Return the already detached
	// JSON payload, not Zod's projection, so hashes and retries cover the exact prefix.
	return payload as RequestSnapshot
}

function recordPath(globalStoragePath: string, taskId: string, requestId?: string): string {
	pathIdSchema.parse(taskId)
	if (requestId !== undefined) pathIdSchema.parse(requestId)
	if (!path.isAbsolute(globalStoragePath)) throw new Error("Storage path must be absolute")
	return path.join(
		globalStoragePath,
		"tasks",
		taskId,
		"model-operation",
		requestId === undefined ? "branch-provenance.json" : `request-${requestId}.json`,
	)
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code
}

// The supplied root is trusted. Refuse existing symlinks beneath it; this is not
// a sandbox against an adversary concurrently replacing directories on disk.
async function assertNoSymlinks(root: string, filePath: string): Promise<void> {
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

async function readEnvelope(
	root: string,
	filePath: string,
	recordType: Envelope["recordType"],
	taskId: string,
	requestId?: string,
): Promise<Envelope | undefined> {
	await assertNoSymlinks(root, filePath)
	let text: string
	try {
		if (!(await fs.lstat(filePath)).isFile()) throw new Error("Model-operation record must be a regular file")
		text = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined
		throw error
	}
	const envelope = envelopeSchema.parse(JSON.parse(text))
	const { checksum, ...record } = envelope
	if (record.recordType !== recordType || record.taskId !== taskId || record.requestId !== requestId) {
		throw new Error("Model-operation record identity mismatch")
	}
	if (digest(record) !== checksum) throw new Error("Model-operation record checksum mismatch")
	if (recordType === "requestSnapshot") {
		const snapshot = validateSnapshot(record.payload)
		if (snapshot.taskId !== taskId || snapshot.requestId !== requestId) {
			throw new Error("Request snapshot identity mismatch")
		}
	} else {
		provenanceSchema.parse(record.payload)
	}
	return envelope
}

async function syncFile(filePath: string): Promise<void> {
	const handle = await fs.open(filePath, "r")
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

async function syncPublishedRecord(root: string, filePath: string): Promise<void> {
	// An existing record may come from a writer that failed or crashed after link().
	// Re-establish durability even for identical retries and concurrent winners.
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

async function saveImmutable(root: string, filePath: string, record: Omit<Envelope, "checksum">): Promise<void> {
	const checksum = digest(record)
	const existing = await readEnvelope(root, filePath, record.recordType, record.taskId, record.requestId)
	if (existing) {
		if (existing.checksum !== checksum) throw new Error("Immutable model-operation record collision")
		await syncPublishedRecord(root, filePath)
		return
	}
	const stagingPath = path.join(path.dirname(filePath), `.pending-${randomUUID()}.json`)
	try {
		// safeWriteJson creates parents. A same-directory hard link publishes a
		// complete inode without overwriting: atomic across processes, no stale lock.
		await safeWriteJson(stagingPath, { ...record, checksum })
		await syncFile(stagingPath)
		await assertNoSymlinks(root, filePath)
		try {
			await fs.link(stagingPath, filePath)
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error
			const winner = await readEnvelope(root, filePath, record.recordType, record.taskId, record.requestId)
			if (winner?.checksum !== checksum) throw new Error("Immutable model-operation record collision")
		}
		// Persist every newly created directory entry through the trusted root,
		// not only the leaf containing the record. Any sync failure is surfaced.
		await syncPublishedRecord(root, filePath)
	} finally {
		await fs.rm(stagingPath, { force: true })
	}
}

/**
 * Uses <root>/tasks/<taskId>/model-operation/request-<requestId>.json. Pass the
 * effective storage root (resolve any custom storage setting at the call site).
 * Exact retries succeed, differing records or corrupted existing files throw.
 * Atomic publication requires hard-link support; there is no unsafe fallback.
 * A crash can leave an ignored .pending file. Checksums detect corruption, not
 * malicious edits. The caller must provision a durable storage root. Windows
 * has no directory-fsync power-loss guarantee.
 */
export async function saveRequestSnapshot(globalStoragePath: string, snapshot: RequestSnapshot): Promise<void> {
	const copy = validateSnapshot(JSON.parse(canonicalJson(snapshot)))
	const filePath = recordPath(globalStoragePath, copy.taskId, copy.requestId)
	await saveImmutable(globalStoragePath, filePath, {
		version: 1,
		recordType: "requestSnapshot",
		taskId: copy.taskId,
		requestId: copy.requestId,
		payload: copy,
	})
}

/** Missing means unavailable; malformed, mismatched or corrupt records throw. */
export async function readRequestSnapshot(
	globalStoragePath: string,
	taskId: string,
	requestId: string,
): Promise<RequestSnapshot | undefined> {
	const envelope = await readEnvelope(
		globalStoragePath,
		recordPath(globalStoragePath, taskId, requestId),
		"requestSnapshot",
		taskId,
		requestId,
	)
	return envelope ? validateSnapshot(envelope.payload) : undefined
}

/** Persist independently of UI/API history before exposing or executing a branch. */
export async function saveBranchProvenance(
	globalStoragePath: string,
	taskId: string,
	provenance: BranchProvenance,
): Promise<void> {
	const copy = provenanceSchema.parse(JSON.parse(canonicalJson(provenance)))
	await saveImmutable(globalStoragePath, recordPath(globalStoragePath, taskId), {
		version: 1,
		recordType: "branchProvenance",
		taskId,
		payload: copy,
	})
}

/** Missing provenance must not be interpreted as an approval grant. */
export async function readBranchProvenance(
	globalStoragePath: string,
	taskId: string,
): Promise<BranchProvenance | undefined> {
	const envelope = await readEnvelope(
		globalStoragePath,
		recordPath(globalStoragePath, taskId),
		"branchProvenance",
		taskId,
	)
	return envelope ? provenanceSchema.parse(envelope.payload) : undefined
}

/** Fixed fail-closed limits, not truncation. All copies and comparisons use 64 KiB buffers. */
export const BRANCH_COMMAND_ARTIFACT_LIMITS = Object.freeze({
	maxDirectoryEntries: 10_000,
	maxFiles: 1_000,
	maxFileBytes: 128 * 1024 * 1024,
	maxTotalBytes: 512 * 1024 * 1024,
})

function commandOutputPath(root: string, taskId: string): string {
	// Share identity/root validation with snapshot storage, including reserved names.
	recordPath(root, taskId)
	return path.join(root, "tasks", taskId, "command-output")
}

async function regularArtifact(root: string, filePath: string): Promise<Stats> {
	await assertNoSymlinks(root, filePath)
	const stat = await fs.lstat(filePath)
	if (!stat.isFile()) throw new Error("Command artifact must be a regular file")
	if (stat.size > BRANCH_COMMAND_ARTIFACT_LIMITS.maxFileBytes) throw new Error("Command artifact size limit exceeded")
	return stat
}

/** Read a stable, bounded file, optionally writing its bytes to a private staging inode. */
async function streamArtifact(root: string, filePath: string, output?: fs.FileHandle): Promise<string> {
	const before = await regularArtifact(root, filePath)
	const input = await fs.open(filePath, "r")
	try {
		const opened = await input.stat()
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
			throw new Error("Command artifact changed during copy")
		const hash = createHash("sha256")
		const buffer = Buffer.alloc(64 * 1024)
		let position = 0
		while (position < before.size) {
			const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position)
			if (!bytesRead) throw new Error("Command artifact changed during copy")
			const chunk = buffer.subarray(0, bytesRead)
			hash.update(chunk)
			if (output) await output.writeFile(chunk)
			position += bytesRead
		}
		const extra = await input.read(buffer, 0, 1, position)
		const after = await input.stat()
		if (
			extra.bytesRead ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		)
			throw new Error("Command artifact changed during copy")
		return hash.digest("hex")
	} finally {
		await input.close()
	}
}

async function copyImmutableArtifact(root: string, source: string, destination: string): Promise<void> {
	await assertNoSymlinks(root, destination)
	await fs.mkdir(path.dirname(destination), { recursive: true })
	const stagingPath = path.join(path.dirname(destination), `.pending-${randomUUID()}.tmp`)
	const output = await fs.open(stagingPath, "wx", 0o600)
	try {
		const checksum = await streamArtifact(root, source, output)
		await output.sync()
		await output.close()
		await assertNoSymlinks(root, destination)
		try {
			// Never link the source inode: later source writes must not affect the branch.
			await fs.link(stagingPath, destination)
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error
			if ((await streamArtifact(root, destination)) !== checksum)
				throw new Error("Immutable command artifact collision")
		}
		await syncPublishedRecord(root, destination)
	} finally {
		await output.close()
		await fs.rm(stagingPath, { force: true })
	}
}

/**
 * Copy ALL readable command artifacts from a quiescent standalone source before
 * activation. No reference extraction or ancestor traversal. Missing source output
 * directories mean no artifacts; missing files/errors during copying fail closed.
 * Ignore unrelated files, reject malformed cmd-* names, symlinks and special files.
 * Limits bound enumeration, bytes and memory; exceeding any limit fails, never truncates.
 * Exact retries verify bytes without replacing destination inodes. Partial failures
 * can leave immutable copies in the unactivated branch; the caller must not activate it.
 * Same trusted-root/no-hostile-directory-replacement threat model as JSON storage.
 */
export async function copyBranchCommandArtifacts(
	globalStoragePath: string,
	sourceTaskId: string,
	branchTaskId: string,
): Promise<void> {
	const source = commandOutputPath(globalStoragePath, sourceTaskId)
	const destination = commandOutputPath(globalStoragePath, branchTaskId)
	if (source === destination || (process.platform === "win32" && source.toLowerCase() === destination.toLowerCase()))
		throw new Error("Branch command artifacts require distinct tasks")
	await assertNoSymlinks(globalStoragePath, source)
	await assertNoSymlinks(globalStoragePath, destination)
	let directory: Awaited<ReturnType<typeof fs.opendir>>
	try {
		directory = await fs.opendir(source)
	} catch (error) {
		if (hasCode(error, "ENOENT")) return
		throw error
	}
	const files: { name: string; size: number }[] = []
	let entries = 0
	let totalBytes = 0
	for await (const entry of directory) {
		if (++entries > BRANCH_COMMAND_ARTIFACT_LIMITS.maxDirectoryEntries)
			throw new Error("Command artifact directory entry limit exceeded")
		if (!entry.name.startsWith("cmd-")) continue
		if (!/^cmd-\d+\.txt$/.test(entry.name) || entry.name.length > 128)
			throw new Error("Invalid command artifact filename")
		const stat = await regularArtifact(globalStoragePath, path.join(source, entry.name))
		files.push({ name: entry.name, size: stat.size })
		totalBytes += stat.size
		if (
			files.length > BRANCH_COMMAND_ARTIFACT_LIMITS.maxFiles ||
			totalBytes > BRANCH_COMMAND_ARTIFACT_LIMITS.maxTotalBytes
		)
			throw new Error("Command artifact copy limit exceeded")
	}
	for (const file of files) {
		const sourceFile = path.join(source, file.name)
		if ((await regularArtifact(globalStoragePath, sourceFile)).size !== file.size)
			throw new Error("Command artifact changed during copy")
		await copyImmutableArtifact(globalStoragePath, sourceFile, path.join(destination, file.name))
	}
}

/**
 * Prepare durable branch-owned replay data, then publish immutable provenance last.
 * The source snapshot is detached before the first await and never rewritten. The
 * local snapshot keeps the selected request ID/prefix but is bound to branchTaskId.
 * Caller must validate standalone/workspace/profile policy, quiesce the source, and
 * await success before persisting branch histories or activating/starting the branch.
 * JSON writes use safeWriteJson via the immutable storage helpers above.
 */
export async function saveBranchReplay(
	globalStoragePath: string,
	branchTaskId: string,
	snapshot: RequestSnapshot,
	provenance: BranchProvenance,
): Promise<BranchProvenance> {
	const copy = validateSnapshot(JSON.parse(canonicalJson(snapshot)))
	const origin = provenanceSchema.parse(JSON.parse(canonicalJson(provenance)))
	if (origin.sourceTaskId !== copy.taskId || origin.sourceRequestId !== copy.requestId)
		throw new Error("Branch replay provenance identity mismatch")
	recordPath(globalStoragePath, branchTaskId, copy.requestId)
	await copyBranchCommandArtifacts(globalStoragePath, copy.taskId, branchTaskId)
	await saveRequestSnapshot(globalStoragePath, { ...copy, taskId: branchTaskId })
	const local = { ...origin, replaySnapshotRequestId: copy.requestId }
	await saveBranchProvenance(globalStoragePath, branchTaskId, local)
	return local
}

/**
 * Read only the branch-local snapshot for new provenance, without source fallback.
 * Legacy provenance retains its exact single source lookup for compatibility, not
 * a recursive graph/runtime artifact lookup. Missing data remains unavailable.
 */
export async function readBranchReplaySnapshot(
	globalStoragePath: string,
	branchTaskId: string,
	provenance: BranchProvenance,
): Promise<RequestSnapshot | undefined> {
	recordPath(globalStoragePath, branchTaskId)
	const origin = provenanceSchema.parse(JSON.parse(canonicalJson(provenance)))
	return origin.replaySnapshotRequestId === undefined
		? readRequestSnapshot(globalStoragePath, origin.sourceTaskId, origin.sourceRequestId)
		: readRequestSnapshot(globalStoragePath, branchTaskId, origin.replaySnapshotRequestId)
}
