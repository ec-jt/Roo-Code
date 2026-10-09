import type { ChatFileSummary, ChatWindowState, ClineMessage, ClineSayTool, TokenUsage } from "@roo-code/types"

type ApiData = Partial<Record<"tokensIn" | "tokensOut" | "cacheWrites" | "cacheReads" | "cost", number>>
type Contribution = { api?: ApiData; cost: number; context: number; files: ChatFileSummary[]; kind?: string }
const numericKeys = ["tokensIn", "tokensOut", "cacheWrites", "cacheReads", "cost"] as const
const fileTools = new Set(["editedExistingFile", "appliedDiff", "newFileCreated"])

function parse(text?: string): Record<string, unknown> {
	try {
		const value = JSON.parse(text || "{}")
		return value && typeof value === "object" ? value : {}
	} catch {
		return {}
	}
}

export function fileChanges(message: ClineMessage): ChatFileSummary[] {
	return fileDiffs(message).map(({ path, added, removed }) => ({ path, added, removed, changes: 1 }))
}

/** Used only during indexing or an explicit native-editor request. No diff is retained in the index. */
export function fileDiffs(message: ClineMessage) {
	if (message.partial || !(message.say === "tool" || (message.ask === "tool" && message.isAnswered))) return []
	const tool = parse(message.text) as unknown as ClineSayTool
	if (!fileTools.has(tool.tool)) return []
	const entries = Array.isArray(tool.batchDiffs)
		? tool.batchDiffs.map((file) => ({
				path: file.path,
				diff: file.content ?? file.diffs?.map((diff) => diff.content).join("\n") ?? "",
				diffStats: file.diffStats,
			}))
		: [{ path: tool.path, diff: tool.diff ?? tool.content ?? "", diffStats: tool.diffStats }]
	return entries
		.filter((entry) => typeof entry.path === "string" && typeof entry.diff === "string" && entry.diff.length > 0)
		.map((entry) => ({
			path: entry.path!,
			diff: entry.diff,
			added: entry.diffStats?.added ?? 0,
			removed: entry.diffStats?.removed ?? 0,
		}))
}

/** Incremental metadata only. Authoritative message bodies remain owned by Task. */
export class ChatHistoryIndex {
	private source?: ClineMessage[]
	private length = 0
	// Message objects identify live rows; numeric maps below use array positions,
	// never timestamps (several messages can be created in the same millisecond).
	private positions = new WeakMap<ClineMessage, number>()
	private rows = new Map<number, Contribution>()
	private unmatched: number[] = []
	private finishes = new Map<number, number>()
	private starts = new Map<number, number>()
	private files = new Map<string, ChatFileSummary>()
	private contexts: number[] = []
	private contextCapacity = 1
	private cacheWrites = 0
	private cacheReads = 0
	private totals: TokenUsage = this.emptyTotals()
	public revision = 0
	/** Counts parsed/visited source rows, useful for metadata diagnostics and regression tests. */
	public processedMessages = 0
	public rebuilds = 0

	private emptyTotals(): TokenUsage {
		return { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 }
	}

	public ensure(messages: ClineMessage[]) {
		if (this.source !== messages || this.length !== messages.length) this.rebuild(messages)
		return this
	}

	public rebuild(messages: ClineMessage[]) {
		this.source = messages
		this.length = 0
		this.positions = new WeakMap()
		this.rows.clear()
		this.applied.clear()
		this.unmatched = []
		this.finishes.clear()
		this.starts.clear()
		this.files.clear()
		this.contexts = []
		this.contextCapacity = 1
		this.cacheWrites = this.cacheReads = 0
		this.totals = this.emptyTotals()
		this.rebuilds++
		for (const message of messages) this.appendRow(message)
		this.revision++
	}

	public append(messages: ClineMessage[], message: ClineMessage) {
		if (this.source !== messages || this.length !== messages.length - 1) return this.rebuild(messages)
		this.appendRow(message)
		this.revision++
	}

	public update(messages: ClineMessage[], message: ClineMessage) {
		this.ensure(messages)
		const position = this.positions.get(message)
		if (position === undefined) return this.rebuild(messages)
		const previous = this.rows.get(position)!
		const kind = message.type === "say" ? message.say : undefined
		if (
			previous.kind !== kind &&
			[previous.kind, kind].some((k) => k === "api_req_started" || k === "api_req_finished")
		) {
			return this.rebuild(messages)
		}
		this.apply(position, previous, -1)
		this.rows.set(position, this.contribution(message, position))
		this.apply(position, this.rows.get(position)!, 1)
		const start = this.starts.get(position)
		if (start !== undefined) this.refreshStart(start)
		this.revision++
	}

	private appendRow(message: ClineMessage) {
		const position = this.length++
		this.positions.set(message, position)
		this.rows.set(position, this.contribution(message, position))
		if (position > 0 && message.type === "say") {
			if (message.say === "api_req_started") this.unmatched.push(position)
			if (message.say === "api_req_finished") {
				const start = this.unmatched.pop()
				if (start !== undefined) {
					this.finishes.set(start, position)
					this.starts.set(position, start)
					this.refreshStart(start)
				}
			}
		}
		this.apply(position, this.rows.get(position)!, 1)
	}

	private contribution(message: ClineMessage, position: number): Contribution {
		this.processedMessages++
		const result: Contribution = {
			cost: 0,
			context: 0,
			files: fileChanges(message),
			kind: message.type === "say" ? message.say : undefined,
		}
		if (position === 0 || message.type !== "say") return result
		if (message.say === "api_req_started" || message.say === "api_req_finished") {
			const parsed = parse(message.text)
			result.api = {}
			for (const key of numericKeys) {
				if (Object.prototype.hasOwnProperty.call(parsed, key)) {
					// Preserve an explicit invalid/null override, which removes the start value in legacy pairs.
					result.api[key] =
						typeof parsed[key] === "number" && Number.isFinite(parsed[key]) ? parsed[key] : undefined
				}
			}
		} else if (message.say === "condense_context") {
			result.cost = message.contextCondense?.cost ?? 0
			result.context = message.contextCondense?.newContextTokens ?? 0
		} else if (message.say === "sliding_window_truncation") {
			result.cost = message.contextTruncation?.cost ?? 0
			result.context = message.contextTruncation?.newContextTokens ?? 0
		}
		return result
	}

	private effective(position: number, row: Contribution): ApiData {
		const finish = this.finishes.get(position)
		return finish === undefined ? (row.api ?? {}) : { ...row.api, ...this.rows.get(finish)?.api }
	}

	private refreshStart(position: number) {
		// Remove the previously applied snapshot, then apply the new merged pair.
		const row = this.rows.get(position)!
		this.apply(position, row, -1)
		this.apply(position, row, 1)
	}

	private applied = new Map<number, ApiData>()
	private apply(position: number, row: Contribution, sign: 1 | -1) {
		if (row.kind === "api_req_started") {
			const api = sign === -1 ? (this.applied.get(position) ?? {}) : this.effective(position, row)
			this.totals.totalTokensIn += sign * (api.tokensIn ?? 0)
			this.totals.totalTokensOut += sign * (api.tokensOut ?? 0)
			this.totals.totalCost += sign * (api.cost ?? 0)
			this.totals.totalCacheWrites = (this.totals.totalCacheWrites ?? 0) + sign * (api.cacheWrites ?? 0)
			this.totals.totalCacheReads = (this.totals.totalCacheReads ?? 0) + sign * (api.cacheReads ?? 0)
			if (api.cacheWrites !== undefined) this.cacheWrites += sign
			if (api.cacheReads !== undefined) this.cacheReads += sign
			if (sign === 1) this.applied.set(position, api)
			this.setContext(position, sign === 1 ? (api.tokensIn ?? 0) + (api.tokensOut ?? 0) : 0)
		} else {
			this.totals.totalCost += sign * row.cost
			if (row.kind === "condense_context" || row.kind === "sliding_window_truncation")
				this.setContext(position, sign === 1 ? row.context : 0)
		}
		for (const file of row.files) {
			const total = this.files.get(file.path) ?? { path: file.path, added: 0, removed: 0, changes: 0 }
			total.added += sign * file.added
			total.removed += sign * file.removed
			total.changes += sign
			if (total.changes === 0) this.files.delete(file.path)
			else this.files.set(file.path, total)
		}
	}

	/** A last-nonzero segment tree avoids rescanning history when the newest request is still empty. */
	private setContext(position: number, value: number) {
		while (position >= this.contextCapacity) {
			const old = this.contexts
			const capacity = this.contextCapacity
			this.contextCapacity *= 2
			this.contexts = []
			for (let i = 0; i < capacity; i++) this.contexts[this.contextCapacity + i] = old[capacity + i] ?? 0
			for (let i = this.contextCapacity - 1; i > 0; i--)
				this.contexts[i] = this.contexts[i * 2 + 1] || this.contexts[i * 2] || 0
		}
		let i = this.contextCapacity + position
		this.contexts[i] = value
		while ((i = Math.floor(i / 2)) > 0) this.contexts[i] = this.contexts[i * 2 + 1] || this.contexts[i * 2] || 0
	}

	public get tokenUsage(): TokenUsage {
		return {
			...this.totals,
			totalCacheWrites: this.cacheWrites ? this.totals.totalCacheWrites : undefined,
			totalCacheReads: this.cacheReads ? this.totals.totalCacheReads : undefined,
			contextTokens: this.contexts[1] || 0,
		}
	}

	public summary(): ChatWindowState["summary"] {
		const files: ChatFileSummary[] = []
		let bytes = 0
		for (const file of this.files.values()) {
			const size = Buffer.byteLength(JSON.stringify(file))
			if (files.length >= 200 || bytes + size > 64 * 1024) break
			files.push({ ...file })
			bytes += size
		}
		return { tokenUsage: this.tokenUsage, files, filesOmitted: this.files.size - files.length }
	}
}
