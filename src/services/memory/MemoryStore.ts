import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { stringify } from "yaml"
import { atomicText, directory, hash, locked, readText } from "./files"
import { ID_PATTERN, parseRecord, parseYaml, serializeRecord, validateId, validateInput } from "./records"
import {
	MEMORY_LIMITS,
	MemoryError,
	type MemoryAuthorization,
	type MemoryConsent,
	type MemoryIndex,
	type MemoryInput,
	type MemoryIssue,
	type MemoryList,
	type MemoryProject,
	type MemoryRecord,
	type MemoryScope,
} from "./types"

interface Inventory {
	records: MemoryRecord[]
	errors: MemoryIssue[]
	revision: string
	bytes: number
	files: { id: string; revision: string; bytes: number }[]
}

const DEFAULT_CONSENT: MemoryConsent = { enabled: false, personalRecall: false, revision: "disabled" }
const INDEX_HEADER = "<!-- Roo managed memory index: "

export class MemoryStore {
	readonly storageRoot: string
	readonly project: MemoryProject

	constructor(storageRoot: string, project: MemoryProject) {
		if (!path.isAbsolute(storageRoot) || !/^[0-9a-f]{64}$/.test(project.key))
			throw new MemoryError("UNSAFE_PATH", "Invalid memory storage root or project identity")
		this.storageRoot = path.resolve(storageRoot)
		this.project = { ...project }
	}

	getDirectory(scope: MemoryScope): string {
		if (scope !== "project" && scope !== "personal") throw new MemoryError("INVALID_SCOPE", "Invalid memory scope")
		return scope === "personal"
			? path.join(this.storageRoot, "memory", "personal")
			: path.join(this.storageRoot, "memory", "projects", this.project.key)
	}

	getRecordPath(scope: MemoryScope, id: string): string {
		validateId(id)
		return path.join(this.getDirectory(scope), `${id}.md`)
	}

	private get controlPath(): string {
		return path.join(this.storageRoot, "memory", "controls", `${this.project.key}.md`)
	}

	/** Side-effect-free, including when the storage root does not exist. Invalid controls fail closed. */
	async getConsent(): Promise<MemoryConsent> {
		const text = await readText(this.controlPath, 4096)
		if (text === undefined) return { ...DEFAULT_CONSENT }
		const data = parseYaml(text)
		if (
			Object.keys(data).sort().join(",") !== "enabled,personalRecall,revision" ||
			typeof data.enabled !== "boolean" ||
			typeof data.personalRecall !== "boolean" ||
			typeof data.revision !== "string" ||
			!ID_PATTERN.test(data.revision)
		) {
			throw new MemoryError("INVALID_CONSENT", "Invalid memory consent settings; automatic access is blocked")
		}
		return data as unknown as MemoryConsent
	}

	/** UI-authorized only. Not an API for models or repository settings. */
	async setConsent(
		settings: Pick<MemoryConsent, "enabled" | "personalRecall">,
		expectedRevision: string,
	): Promise<MemoryConsent> {
		if (
			typeof settings.enabled !== "boolean" ||
			typeof settings.personalRecall !== "boolean" ||
			Object.keys(settings).some((key) => !["enabled", "personalRecall"].includes(key))
		)
			throw new MemoryError("INVALID_CONSENT", "Invalid memory consent settings")
		return locked(`${this.controlPath}.guard`, async (assertLock) => {
			const old = await this.getConsent()
			if (old.revision !== expectedRevision)
				throw new MemoryError("CONFLICT", "Memory consent changed; refresh settings")
			const raw = await readText(this.controlPath, 4096)
			const result = { ...settings, revision: randomUUID() }
			assertLock()
			await atomicText(this.controlPath, stringify(result), raw === undefined ? null : hash(raw), 4096)
			return result
		})
	}

	private async tombstones(scope: MemoryScope): Promise<{ text: string | undefined; ids: Set<string> }> {
		const text = await readText(path.join(this.getDirectory(scope), "forgotten.txt"), MEMORY_LIMITS.tombstoneBytes)
		const ids = new Set(text?.split("\n").filter(Boolean) ?? [])
		for (const id of ids) validateId(id)
		return { text, ids }
	}

	private issue(file: string, error: unknown): MemoryIssue {
		return {
			file,
			code: error instanceof MemoryError ? error.code : "IO_ERROR",
			message:
				error instanceof MemoryError
					? error.message
					: "Unable to read memory file; inspect its permissions and type",
		}
	}

	private async inventory(scope: MemoryScope): Promise<Inventory> {
		const dir = this.getDirectory(scope)
		const records: MemoryRecord[] = []
		const errors: MemoryIssue[] = []
		const files: Inventory["files"] = []
		const markers: string[] = []
		let bytes = 0
		if (!(await directory(dir))) return { records, errors, files, bytes, revision: hash(`forgotten:${hash("")}`) }
		const { ids: forgotten, text: tombstoneText } = await this.tombstones(scope)
		markers.push(`forgotten:${hash(tombstoneText ?? "")}`)
		const names: string[] = []
		const stream = await fs.opendir(dir)
		for await (const entry of stream) {
			names.push(entry.name)
			if (names.length > MEMORY_LIMITS.directoryEntries)
				throw new MemoryError("LIMIT", "Memory directory has too many entries; review files manually")
		}
		for (const name of names.sort()) {
			if (name === "MEMORY.md" || !name.endsWith(".md")) continue
			const id = name.slice(0, -3)
			try {
				validateId(id)
				const raw = await readText(path.join(dir, name), MEMORY_LIMITS.topicBytes)
				if (raw === undefined) continue
				const revision = hash(raw)
				markers.push(`${name}:${revision}`)
				const size = Buffer.byteLength(raw)
				bytes += size
				files.push({ id, revision, bytes: size })
				if (forgotten.has(id))
					throw new MemoryError(
						"FORGOTTEN",
						"Forgotten record remains on disk after an interrupted deletion; delete it manually",
					)
				if (bytes > MEMORY_LIMITS.storeBytes)
					throw new MemoryError("LIMIT", "Memory store exceeds 2 MiB; remove or shorten topics")
				if (records.length >= MEMORY_LIMITS.maxRecords)
					throw new MemoryError("LIMIT", "Memory store exceeds 200 valid topics; remove or merge topics")
				records.push(parseRecord(raw, id))
			} catch (error) {
				errors.push(this.issue(name, error))
				markers.push(`${name}:error:${errors.at(-1)!.code}`)
			}
		}
		// The cache is never authoritative. Detect edits and leave them available for review.
		try {
			const cache = await readText(path.join(dir, "MEMORY.md"), MEMORY_LIMITS.indexBytes + 256)
			if (cache !== undefined && !this.managedIndex(cache))
				errors.push({
					file: "MEMORY.md",
					code: "INDEX_EDITED",
					message:
						"Index was edited manually; it is preserved but not recalled. Move durable content into a topic.",
				})
		} catch (error) {
			errors.push(this.issue("MEMORY.md", error))
		}
		return { records, errors, files, bytes, revision: hash(markers.join("\n")) }
	}

	/** Explicit manual browsing is available while disabled. Tool callers enforce current consent separately. */
	async list(scope: MemoryScope, query = "", limit: number = MEMORY_LIMITS.listDefault): Promise<MemoryList> {
		if (
			typeof query !== "string" ||
			query.length > 512 ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > MEMORY_LIMITS.maxRecords
		)
			throw new MemoryError("LIMIT", "Invalid memory search or result limit")
		const inventory = await this.inventory(scope)
		const needle = query.toLowerCase()
		const matches = inventory.records.filter((record) =>
			[record.name, record.description, record.body, record.type].some((value) =>
				value.toLowerCase().includes(needle),
			),
		)
		return {
			records: matches.slice(0, limit),
			errors: inventory.errors,
			revision: inventory.revision,
			total: matches.length,
			omitted: Math.max(0, matches.length - limit),
		}
	}

	async read(scope: MemoryScope, id: string): Promise<MemoryRecord | undefined> {
		const file = this.getRecordPath(scope, id)
		if ((await this.tombstones(scope)).ids.has(id)) return undefined
		const raw = await readText(file, MEMORY_LIMITS.topicBytes)
		return raw === undefined ? undefined : parseRecord(raw, id)
	}

	private buildIndex(
		entries: { scope: MemoryScope; record: MemoryRecord }[],
		revision: string,
		errors: MemoryIssue[],
		maxBytes: number,
	): MemoryIndex {
		const lines: string[] = []
		let bytes = 0
		for (const { scope, record } of entries) {
			// JSON string quoting prevents newlines and Markdown/HTML from becoming structure.
			const line = `${scope}:${record.id} ${JSON.stringify(record.name)} (${record.type}): ${JSON.stringify(record.description)}`
			const size = Buffer.byteLength(line) + 1
			if (bytes + size > maxBytes || lines.length >= MEMORY_LIMITS.indexLines) break
			lines.push(line)
			bytes += size
		}
		return {
			text: lines.length ? `${lines.join("\n")}\n` : "",
			revision,
			count: lines.length,
			omitted: entries.length - lines.length,
			errors,
		}
	}

	/** Bounded derived index for manual UI preview; does not write files or require consent. */
	async getIndex(scope: MemoryScope): Promise<MemoryIndex> {
		const inventory = await this.inventory(scope)
		return this.buildIndex(
			inventory.records.map((record) => ({ scope, record })),
			inventory.revision,
			inventory.errors,
			MEMORY_LIMITS.indexBytes,
		)
	}

	/** Automatic recall only. Recheck at the dispatch boundary too; the returned revision includes consent. */
	async getRecallIndex(maxBytes = MEMORY_LIMITS.indexBytes): Promise<MemoryIndex> {
		if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > MEMORY_LIMITS.indexBytes)
			throw new MemoryError("LIMIT", "Invalid recall budget")
		const consent = await this.getConsent()
		const empty = { text: "", revision: hash(consent.revision), count: 0, omitted: 0, errors: [] }
		if (!consent.enabled) return empty
		const project = await this.inventory("project")
		const personal = consent.personalRecall ? await this.inventory("personal") : undefined
		const current = await this.getConsent()
		if (current.revision !== consent.revision || !current.enabled)
			return { ...empty, revision: hash(current.revision) }
		return this.buildIndex(
			[
				...project.records.map((record) => ({ scope: "project" as const, record })),
				...(personal?.records.map((record) => ({ scope: "personal" as const, record })) ?? []),
			],
			hash(`${consent.revision}:${project.revision}:${personal?.revision ?? ""}`),
			[...project.errors, ...(personal?.errors ?? [])],
			maxBytes,
		)
	}

	private managedIndex(text: string): boolean {
		const newline = text.indexOf("\n")
		return newline >= 0 && text.slice(0, newline) === `${INDEX_HEADER}${hash(text.slice(newline + 1))} -->`
	}

	private async reconcile(scope: MemoryScope): Promise<void> {
		const file = path.join(this.getDirectory(scope), "MEMORY.md")
		try {
			const previous = await readText(file, MEMORY_LIMITS.indexBytes + 256)
			if (previous !== undefined && !this.managedIndex(previous)) return
			const index = await this.getIndex(scope)
			const body = `${index.text}\nOmitted: ${index.omitted}; invalid files: ${index.errors.length}\n`
			await atomicText(
				file,
				`${INDEX_HEADER}${hash(body)} -->\n${body}`,
				previous === undefined ? null : hash(previous),
				MEMORY_LIMITS.indexBytes + 256,
			)
		} catch {
			// A committed topic remains authoritative even if its derived cache cannot be refreshed.
			// Subsequent reads derive the current index and report unsafe/edited cache files.
		}
	}

	private async requireConsent(expected: MemoryConsent): Promise<void> {
		const current = await this.getConsent()
		if (!current.enabled || current.revision !== expected.revision)
			throw new MemoryError("DISABLED", "Memory consent was disabled or changed; start a new operation")
	}

	async upsert(
		scope: MemoryScope,
		input: MemoryInput,
		options: MemoryAuthorization & { expectedRevision: string | null },
	): Promise<MemoryRecord> {
		validateInput(input)
		if (input.id === undefined ? options.expectedRevision !== null : typeof options.expectedRevision !== "string")
			throw new MemoryError(
				"CONFLICT",
				"Creation requires a null revision and no ID; updates require an ID and its exact revision",
			)
		const consent = await this.getConsent()
		if (!consent.enabled) throw new MemoryError("DISABLED", "Enable project memory before saving")
		return locked(path.join(this.getDirectory(scope), ".scope"), async (assertLock) => {
			await this.requireConsent(consent)
			const existing = input.id ? await this.read(scope, input.id) : undefined
			if (input.id && (!existing || existing.revision !== options.expectedRevision))
				throw new MemoryError("CONFLICT", "Memory changed or was forgotten; reread before retrying")
			const inventory = await this.inventory(scope)
			if (inventory.errors.some((issue) => issue.file !== "MEMORY.md"))
				throw new MemoryError("INVALID_STORE", "Review invalid memory files before saving")
			if (!existing && inventory.records.length >= MEMORY_LIMITS.maxRecords)
				throw new MemoryError("LIMIT", "Memory store has 200 topics; remove or merge one before saving")
			const id = existing?.id ?? randomUUID()
			const now = new Date().toISOString()
			const record = { ...input, id, createdAt: existing?.createdAt ?? now, modifiedAt: now }
			const raw = serializeRecord(record)
			const previousBytes = inventory.files.find((file) => file.id === id)?.bytes ?? 0
			if (inventory.bytes - previousBytes + Buffer.byteLength(raw) > MEMORY_LIMITS.storeBytes)
				throw new MemoryError("LIMIT", "Memory store exceeds 2 MiB; remove or shorten topics")
			await options.authorize()
			// The callback may show UI or call setConsent. Acquire the independent consent lock only afterwards.
			await locked(`${this.controlPath}.guard`, async (assertConsentLock) => {
				await this.requireConsent(consent)
				const current = await this.inventory(scope)
				if (current.revision !== inventory.revision)
					throw new MemoryError("CONFLICT", "Memory inventory changed during authorization; retry")
				assertLock()
				assertConsentLock()
				await atomicText(this.getRecordPath(scope, id), raw, options.expectedRevision, MEMORY_LIMITS.topicBytes)
			})
			await this.reconcile(scope)
			return parseRecord(raw, id)
		})
	}

	/** Forgetting is allowed while disabled. The caller must authorize the exact scope and deletion. */
	async delete(
		scope: MemoryScope,
		id: string,
		options: MemoryAuthorization & { expectedRevision: string },
	): Promise<void> {
		validateId(id)
		return locked(path.join(this.getDirectory(scope), ".scope"), async (assertLock) => {
			const record = await this.read(scope, id)
			if (!record || record.revision !== options.expectedRevision)
				throw new MemoryError("CONFLICT", "Memory changed or was forgotten; reread before deleting")
			await options.authorize()
			const raw = await readText(this.getRecordPath(scope, id), MEMORY_LIMITS.topicBytes)
			if (raw === undefined || hash(raw) !== options.expectedRevision)
				throw new MemoryError("CONFLICT", "Memory changed during authorization")
			assertLock()
			await this.forget(scope, [id])
			await this.reconcile(scope)
		})
	}

	/** Uses the unfiltered list inventory revision. Invalid/unsafe records require manual repair. */
	async clear(scope: MemoryScope, options: MemoryAuthorization & { expectedRevision: string }): Promise<void> {
		return locked(path.join(this.getDirectory(scope), ".scope"), async (assertLock) => {
			const inventory = await this.inventory(scope)
			if (inventory.revision !== options.expectedRevision)
				throw new MemoryError("CONFLICT", "Memory inventory changed; review before clearing")
			if (inventory.errors.some((issue) => issue.file !== "MEMORY.md"))
				throw new MemoryError("INVALID_STORE", "Review invalid memory files before clearing")
			await options.authorize()
			if ((await this.inventory(scope)).revision !== inventory.revision)
				throw new MemoryError("CONFLICT", "Memory inventory changed during authorization")
			assertLock()
			await this.forget(
				scope,
				inventory.records.map((record) => record.id),
			)
			await this.reconcile(scope)
		})
	}

	private async forget(scope: MemoryScope, ids: string[]): Promise<void> {
		const previous = await this.tombstones(scope)
		for (const id of ids) previous.ids.add(id)
		const text = [...previous.ids].sort().join("\n") + "\n"
		if (Buffer.byteLength(text) > MEMORY_LIMITS.tombstoneBytes)
			throw new MemoryError("LIMIT", "Memory tombstone capacity reached; review storage before deleting")
		// Tombstones first ensure an interrupted deletion cannot revive a record for recall.
		await atomicText(
			path.join(this.getDirectory(scope), "forgotten.txt"),
			text,
			previous.text === undefined ? null : hash(previous.text),
			MEMORY_LIMITS.tombstoneBytes,
		)
		for (const id of ids) {
			const file = this.getRecordPath(scope, id)
			await readText(file, MEMORY_LIMITS.topicBytes)
			await fs.unlink(file)
		}
	}
}
