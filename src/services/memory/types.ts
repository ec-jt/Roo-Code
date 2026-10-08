export type MemoryScope = "project" | "personal"
export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryProject {
	key: string
	label: string
	rootPath: string
}

export interface MemoryRecord {
	id: string
	name: string
	description: string
	type: MemoryType
	body: string
	createdAt: string
	modifiedAt: string
	sourceTaskId?: string
	revision: string
}

export interface MemoryInput {
	/** Omit to create. Supplied IDs only update existing records. */
	id?: string
	name: string
	description: string
	type: MemoryType
	body: string
	sourceTaskId?: string
}

export interface MemoryConsent {
	enabled: boolean
	personalRecall: boolean
	/** Changes on every settings write, including disable/re-enable. */
	revision: string
}

export interface MemoryIssue {
	file: string
	code: string
	message: string
}

export interface MemoryList {
	records: MemoryRecord[]
	errors: MemoryIssue[]
	/** Whole inventory revision, independent of the search filter and limit. */
	revision: string
	total: number
	omitted: number
}

export interface MemoryIndex {
	text: string
	revision: string
	count: number
	omitted: number
	errors: MemoryIssue[]
}

export interface MemoryAuthorization {
	/** Called with the scope lock held. Do not mutate this scope in the callback. */
	authorize: () => Promise<void>
}

export const MEMORY_LIMITS = Object.freeze({
	maxRecords: 200,
	listDefault: 100,
	indexBytes: 16 * 1024,
	indexLines: 200,
	topicBytes: 32 * 1024,
	topicLines: 512,
	frontmatterBytes: 4096,
	storeBytes: 2 * 1024 * 1024,
	directoryEntries: 1024,
	tombstoneBytes: 256 * 1024,
})

export class MemoryError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message)
		this.name = "MemoryError"
	}
}
