import * as path from "node:path"
import { z } from "zod"

import { canonicalJson, hashJson, publishImmutableJson, readJsonFile } from "./immutable-json"
import type { RequestSnapshot } from "./storage"

// Per-operation safety guards, not retention or a total task storage quota.
export const SNAPSHOT_LIMITS = Object.freeze({
	maxBlockBytes: 64 * 1024 * 1024,
	maxSnapshotBytes: 512 * 1024 * 1024,
	maxManifestBytes: 64 * 1024,
	maxMessages: 1_000_000,
})
const FANOUT = 32
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sequenceSchema = z
	.object({ root: hashSchema.nullable(), count: z.number().int().min(0).max(SNAPSHOT_LIMITS.maxMessages) })
	.strict()
	.refine((value) => (value.count === 0) === (value.root === null), "Invalid empty snapshot sequence")
type Sequence = z.infer<typeof sequenceSchema>
const manifestSchema = z
	.object({
		encoding: z.literal("blocks-v1"),
		metadata: z.unknown(),
		apiMessages: sequenceSchema,
		clineMessages: sequenceSchema,
		systemPrompt: hashSchema,
	})
	.strict()
const nodeSchema = z
	.object({
		version: z.literal(1),
		kind: z.literal("sequence"),
		level: z.number().int().min(0).max(3),
		refs: z.array(hashSchema).min(1).max(FANOUT),
	})
	.strict()
const valueSchema = z
	.object({
		version: z.literal(1),
		kind: z.enum(["api-message", "cline-message", "system-prompt"]),
		value: z.unknown(),
	})
	.strict()
type ValueKind = z.infer<typeof valueSchema>["kind"]
export type SnapshotManifest = z.infer<typeof manifestSchema>

function blockPath(directory: string, hash: string): string {
	// Validate before forming any path, including references loaded from disk.
	hashSchema.parse(hash)
	return path.join(directory, "blocks", hash.slice(0, 2), `${hash}.json`)
}

function rootLevel(count: number): number {
	let level = 0
	while (count > FANOUT ** (level + 1)) level++
	return level
}

export function validateManifest(value: unknown): SnapshotManifest {
	return manifestSchema.parse(value)
}

/** Canonical 32-way tree: unchanged complete prefix nodes retain their hashes. */
export async function saveSnapshotBlocks(
	root: string,
	directory: string,
	snapshot: RequestSnapshot,
): Promise<SnapshotManifest> {
	let totalBytes = 0
	const saved = new Set<string>()
	const put = async (block: unknown): Promise<string> => {
		const text = canonicalJson(block)
		const bytes = Buffer.byteLength(text)
		totalBytes += bytes
		if (bytes > SNAPSHOT_LIMITS.maxBlockBytes || totalBytes > SNAPSHOT_LIMITS.maxSnapshotBytes)
			throw new Error("Request snapshot block size limit exceeded")
		const hash = hashJson(block)
		if (!saved.has(hash)) {
			const file = blockPath(directory, hash)
			await publishImmutableJson(root, file, block, async () => {
				const existing = await readJsonFile(root, file, SNAPSHOT_LIMITS.maxBlockBytes)
				if (!existing) return false
				if (canonicalJson(existing.value) !== text)
					throw new Error("Immutable snapshot block checksum collision")
				return true
			})
			saved.add(hash)
		}
		return hash
	}
	const sequence = async (messages: unknown[], kind: ValueKind): Promise<Sequence> => {
		if (messages.length > SNAPSHOT_LIMITS.maxMessages) throw new Error("Request snapshot message limit exceeded")
		let refs: string[] = []
		for (const value of messages) refs.push(await put({ version: 1, kind, value }))
		if (refs.length === 0) return { root: null, count: 0 }
		let level = 0
		do {
			const parents: string[] = []
			for (let index = 0; index < refs.length; index += FANOUT) {
				parents.push(
					await put({ version: 1, kind: "sequence", level, refs: refs.slice(index, index + FANOUT) }),
				)
			}
			refs = parents
			level++
		} while (refs.length > 1)
		return { root: refs[0], count: messages.length }
	}
	const { apiMessages, clineMessages, systemPrompt, ...metadata } = snapshot
	return {
		encoding: "blocks-v1",
		metadata,
		apiMessages: await sequence(apiMessages, "api-message"),
		clineMessages: await sequence(clineMessages, "cline-message"),
		systemPrompt: await put({ version: 1, kind: "system-prompt", value: systemPrompt }),
	}
}

/** No recursion or cross-task lookup. Counts and decreasing levels bound traversal. */
export async function readSnapshotBlocks(root: string, directory: string, payload: unknown): Promise<unknown> {
	const manifest = validateManifest(payload)
	let totalBytes = 0
	const get = async (hash: string): Promise<unknown> => {
		const file = await readJsonFile(
			root,
			blockPath(directory, hash),
			Math.min(SNAPSHOT_LIMITS.maxBlockBytes, SNAPSHOT_LIMITS.maxSnapshotBytes - totalBytes),
		)
		if (!file) throw new Error("Request snapshot block is missing")
		totalBytes += file.bytes
		if (hashJson(file.value) !== hash) throw new Error("Request snapshot block checksum mismatch")
		return file.value
	}
	const value = async (hash: string, kind: ValueKind): Promise<unknown> => {
		const block = valueSchema.parse(await get(hash))
		if (block.kind !== kind) throw new Error("Request snapshot block type mismatch")
		return block.value
	}
	const sequence = async (descriptor: Sequence, kind: ValueKind): Promise<unknown[]> => {
		if (descriptor.root === null) return []
		const result: unknown[] = []
		const stack = [{ hash: descriptor.root, level: rootLevel(descriptor.count), count: descriptor.count }]
		while (stack.length) {
			const frame = stack.pop()!
			const node = nodeSchema.parse(await get(frame.hash))
			const childCapacity = FANOUT ** frame.level
			if (node.level !== frame.level || node.refs.length !== Math.ceil(frame.count / childCapacity))
				throw new Error("Request snapshot sequence structure mismatch (invalid count, level or cycle)")
			if (frame.level === 0) {
				for (const hash of node.refs) result.push(await value(hash, kind))
			} else {
				for (let index = node.refs.length - 1; index >= 0; index--) {
					stack.push({
						hash: node.refs[index],
						level: frame.level - 1,
						count: Math.min(childCapacity, frame.count - index * childCapacity),
					})
				}
			}
		}
		return result
	}
	// Metadata is validated by the snapshot schema after reconstruction. Require a
	// plain object here so malformed metadata cannot be coerced by object spread.
	const metadata = z.record(z.unknown()).parse(manifest.metadata)
	if (["apiMessages", "clineMessages", "systemPrompt"].some((key) => key in metadata))
		throw new Error("Request snapshot metadata contains history fields")
	return {
		...metadata,
		apiMessages: await sequence(manifest.apiMessages, "api-message"),
		clineMessages: await sequence(manifest.clineMessages, "cline-message"),
		systemPrompt: await value(manifest.systemPrompt, "system-prompt"),
	}
}
