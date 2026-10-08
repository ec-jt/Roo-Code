import { parseDocument, stringify } from "yaml"
import { hash } from "./files"
import { MEMORY_LIMITS, MemoryError, type MemoryInput, type MemoryRecord } from "./types"

export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function validateId(id: string): void {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new MemoryError("INVALID_ID", "Invalid memory record ID")
}

export function parseYaml(text: string): Record<string, unknown> {
	try {
		const doc = parseDocument(text, { uniqueKeys: true, version: "1.2" })
		if (doc.errors.length || doc.warnings.length) throw new Error("Invalid YAML")
		const value = doc.toJS({ maxAliasCount: 0 })
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mapping")
		return value
	} catch {
		throw new MemoryError("INVALID_RECORD", "Invalid metadata; use a plain YAML mapping without aliases or tags")
	}
}

function field(value: unknown, name: string, max: number): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		[...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
	) {
		throw new MemoryError("INVALID_RECORD", `Invalid ${name}`)
	}
}

/** Best effort only. The caller must still avoid retaining sensitive information. */
export function assertNoSecrets(text: string): void {
	const patterns = [
		/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
		/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
		/\b(?:authorization\s*:\s*bearer|bearer)\s+[A-Za-z0-9._~+\/-]{12,}/i,
		/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|session[_-]?(?:cookie|token))\s*[=:]\s*["']?[^\s"']{8,}/i,
		/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
	]
	if (patterns.some((pattern) => pattern.test(text))) {
		throw new MemoryError(
			"SECRET",
			"Possible credential or private key detected; remove it before saving or recalling",
		)
	}
}

export function validateInput(input: MemoryInput): void {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new MemoryError("INVALID_RECORD", "Invalid memory input")
	const allowed = new Set(["id", "name", "description", "type", "body", "sourceTaskId"])
	if (Object.keys(input).some((key) => !allowed.has(key)))
		throw new MemoryError("INVALID_RECORD", "Unknown memory input field")
	if (input.id !== undefined) validateId(input.id)
	field(input.name, "name", 160)
	field(input.description, "description", 512)
	if (!["user", "feedback", "project", "reference"].includes(input.type))
		throw new MemoryError("INVALID_RECORD", "Invalid memory type")
	if (input.sourceTaskId !== undefined) field(input.sourceTaskId, "sourceTaskId", 160)
	if (typeof input.body !== "string" || !input.body.trim() || input.body.includes(String.fromCharCode(0)))
		throw new MemoryError("INVALID_RECORD", "Invalid memory body")
	assertNoSecrets([input.name, input.description, input.body, input.sourceTaskId ?? ""].join("\n"))
}

export function serializeRecord(record: Omit<MemoryRecord, "revision">): string {
	const { body, ...metadata } = record
	const header = stringify(metadata, { lineWidth: 0 })
	if (Buffer.byteLength(header) > MEMORY_LIMITS.frontmatterBytes)
		throw new MemoryError("LIMIT", "Memory metadata exceeds its byte limit")
	const text = `---\n${header}---\n${body}`
	checkTopicLimits(text)
	return text
}

function checkTopicLimits(text: string): void {
	if (Buffer.byteLength(text) > MEMORY_LIMITS.topicBytes || text.split("\n").length > MEMORY_LIMITS.topicLines) {
		throw new MemoryError("LIMIT", "Memory topic exceeds 32 KiB or 512 lines; split or shorten it")
	}
}

export function parseRecord(text: string, id: string): MemoryRecord {
	checkTopicLimits(text)
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
	if (!match || Buffer.byteLength(match[1]) > MEMORY_LIMITS.frontmatterBytes)
		throw new MemoryError("INVALID_RECORD", "Missing or oversized YAML frontmatter")
	const data = parseYaml(match[1])
	const allowed = new Set(["id", "name", "description", "type", "createdAt", "modifiedAt", "sourceTaskId"])
	if (Object.keys(data).some((key) => !allowed.has(key)) || data.id !== id)
		throw new MemoryError("INVALID_RECORD", "Unknown metadata field or mismatched record ID")
	for (const date of [data.createdAt, data.modifiedAt]) {
		if (
			typeof date !== "string" ||
			!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(date) ||
			!Number.isFinite(Date.parse(date)) ||
			new Date(date).toISOString() !== date
		) {
			throw new MemoryError("INVALID_RECORD", "Dates must be valid UTC ISO timestamps")
		}
	}
	if ((data.createdAt as string) > (data.modifiedAt as string))
		throw new MemoryError("INVALID_RECORD", "Modification date precedes creation date")
	const input: MemoryInput = {
		id,
		name: data.name as string,
		description: data.description as string,
		type: data.type as MemoryInput["type"],
		body: text.slice(match[0].length),
		...(data.sourceTaskId === undefined ? {} : { sourceTaskId: data.sourceTaskId as string }),
	}
	validateInput(input)
	return {
		...input,
		id,
		createdAt: data.createdAt as string,
		modifiedAt: data.modifiedAt as string,
		revision: hash(text),
	}
}
