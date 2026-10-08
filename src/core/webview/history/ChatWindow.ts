import type { ChatWindowRequest, ChatWindowState, ClineMessage } from "@roo-code/types"
import { ChatHistoryIndex } from "./ChatHistoryIndex"
import { chatPreviewLabel } from "../../../shared/chat-preview"

export const CHAT_WINDOW_BYTES = 1024 * 1024
export const CHAT_WINDOW_ROWS = 100
export const CHAT_PREVIEW_BYTES = 16 * 1024
export const CHAT_EDITOR_BYTES = 8 * 1024 * 1024

/** Slice before encoding so previewing a large source does not allocate another full-size buffer. */
export function utf8Preview(text: string, bytes: number): string {
	const candidate = text.slice(0, bytes)
	const encoded = Buffer.from(candidate)
	if (encoded.length <= bytes) return candidate.replace(/[\uD800-\uDBFF]$/, "")
	let end = bytes
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--
	return encoded.subarray(0, end).toString("utf8")
}

function preview(message: ClineMessage, limit = CHAT_PREVIEW_BYTES) {
	const text = message.text === undefined ? undefined : utf8Preview(message.text, limit)
	const reasoning = message.reasoning === undefined ? undefined : utf8Preview(message.reasoning, limit)
	let truncated = text !== message.text || reasoning !== message.reasoning
	const images: string[] = []
	for (const image of message.images?.slice(0, 2) ?? []) {
		if (image.length <= 64 * 1024 && Buffer.byteLength(image) <= 64 * 1024) images.push(image)
	}
	if (images.length !== (message.images?.length ?? 0)) truncated = true
	// Unknown nested metadata can contain large strings. A preview has a deliberately small schema.
	const row: ClineMessage = {
		ts: message.ts,
		type: message.type,
		say: message.say,
		ask: message.ask,
		text,
		reasoning,
		partial: message.partial,
		isAnswered: message.isAnswered,
		isProtected: message.isProtected,
		apiProtocol: message.apiProtocol,
		conversationHistoryIndex: message.conversationHistoryIndex,
		...(images.length ? { images } : {}),
	}
	for (const key of ["requestId", "checkpoint", "progressStatus", "contextCondense", "contextTruncation"] as const) {
		const value = message[key]
		if (value === undefined) continue
		const json = JSON.stringify(value)
		if (json.length <= limit && Buffer.byteLength(json) <= limit) Object.assign(row, { [key]: value })
		else truncated = true
	}
	if (Buffer.byteLength(JSON.stringify(row)) > Math.max(limit * 2, 64 * 1024)) {
		// Escaped control characters and nested fields must also respect the wire budget.
		return {
			row: {
				ts: message.ts,
				type: message.type,
				say: message.say,
				ask: message.ask,
				text: utf8Preview(message.text ?? "", Math.floor(limit / 6)),
				partial: message.partial,
				isAnswered: message.isAnswered,
			},
			truncated: true,
		}
	}
	return { row, truncated }
}

export interface WindowTask {
	taskId: string
	instanceId: string
	clineMessages: ClineMessage[]
	chatHistoryIndex?: ChatHistoryIndex
}

/** Per-provider cursor state. Responses replace, never append to, the browser's message collection. */
export class ChatWindow {
	private identity = ""
	private following = true
	private start = 1
	private end = 1
	private direction: "before" | "after" = "before"
	private sequence = 0
	private rebuilds = 0
	private fallbackIndex = new ChatHistoryIndex()
	private reason?: ChatWindowState["reason"]

	public isFollowing(task: WindowTask): boolean {
		return this.identity !== `${task.taskId}:${task.instanceId}` || this.following
	}

	private index(task: WindowTask) {
		const index = (task.chatHistoryIndex ?? this.fallbackIndex).ensure(task.clineMessages)
		const identity = `${task.taskId}:${task.instanceId}`
		if (identity !== this.identity || index.rebuilds !== this.rebuilds) {
			this.identity = identity
			this.following = true
			this.reason = undefined
		}
		this.rebuilds = index.rebuilds
		return index
	}

	public request(task: WindowTask, request: ChatWindowRequest): boolean {
		if (request.taskId !== task.taskId || request.instanceId !== task.instanceId) return false
		const index = this.index(task)
		if (!Number.isSafeInteger(request.revision) || request.revision !== index.revision) {
			this.reason = "staleRevision"
			return true
		}
		if (request.latest) {
			this.following = true
		} else if (
			Number.isSafeInteger(request.before) &&
			request.before! >= 1 &&
			request.before! <= task.clineMessages.length
		) {
			this.following = false
			this.end = request.before!
			this.start = Math.max(1, this.end - CHAT_WINDOW_ROWS)
			this.direction = "before"
		} else if (
			Number.isSafeInteger(request.after) &&
			request.after! >= 1 &&
			request.after! <= task.clineMessages.length
		) {
			this.following = false
			this.start = request.after!
			this.end = Math.min(task.clineMessages.length, this.start + CHAT_WINDOW_ROWS)
			this.direction = "after"
		} else return false
		return true
	}

	public snapshot(task: WindowTask): { clineMessages: ClineMessage[]; chatWindow: ChatWindowState } {
		const index = this.index(task)
		const source = task.clineMessages
		const total = source.length
		let start = this.following ? Math.max(1, total - CHAT_WINDOW_ROWS) : Math.min(this.start, total)
		let end = this.following ? total : Math.min(this.end, total)
		if (total === 0) start = end = 0
		const project = (message: ClineMessage, index: number, limit?: number, keepFull = false) => {
			const entry = keepFull ? { row: { ...message }, truncated: false } : preview(message, limit)
			entry.row.chatPreview = {
				index,
				truncated: entry.truncated,
				label: chatPreviewLabel(message),
				hasContent: !!(message.text?.trim() || message.reasoning?.trim()),
			}
			return entry
		}
		const root = source[0] ? project(source[0], 0, 64 * 1024) : undefined
		const last = this.following ? source.at(-1) : undefined
		const pendingAsk = last?.type === "ask" && !last.isAnswered && !last.partial
		const live = last ? project(last, total - 1, undefined, !!pendingAsk) : undefined
		const liveBytes = live ? Buffer.byteLength(JSON.stringify(live.row)) : 0
		const rows: Array<{ row: ClineMessage; truncated: boolean }> = []
		const chatWindow: ChatWindowState = {
			taskId: task.taskId,
			instanceId: task.instanceId,
			revision: index.revision,
			sequence: ++this.sequence,
			startIndex: start,
			endIndex: end,
			totalMessages: total,
			hasOlder: start > 1,
			hasNewer: end < total,
			following: this.following,
			summary: index.summary(),
			truncatedTs: [],
			byteLength: 0,
			liveMessage: live?.row,
			oversizedLiveAsk: (pendingAsk && liveBytes > CHAT_PREVIEW_BYTES) || undefined,
			reason: this.reason,
		}
		this.reason = undefined
		// Reserve envelope, root, summaries and the explicit control copy before collecting rows.
		let bytes =
			Buffer.byteLength(JSON.stringify(chatWindow)) +
			(root ? Buffer.byteLength(JSON.stringify(root.row)) : 0) +
			8192
		const backwards = this.following || this.direction === "before"
		for (let i = backwards ? end - 1 : start; backwards ? i >= start : i < end; i += backwards ? -1 : 1) {
			const entry = last && source[i] === last ? live! : project(source[i], i)
			const size = Buffer.byteLength(JSON.stringify(entry.row))
			// The latest ask is the sole exception: never hide authorization data to meet a display budget.
			if (bytes + size > CHAT_WINDOW_BYTES && !(source[i] === last && pendingAsk)) {
				if (backwards) start = i + 1
				else end = i
				break
			}
			rows.push(entry)
			bytes += size
		}
		if (backwards) rows.reverse()
		chatWindow.startIndex = start
		chatWindow.endIndex = end
		chatWindow.hasOlder = start > 1
		chatWindow.hasNewer = end < total
		this.start = start
		this.end = end
		const entries = root ? [root, ...rows] : rows
		chatWindow.truncatedTs = [
			...new Set(
				[...entries, ...(live ? [live] : [])].filter((entry) => entry.truncated).map((entry) => entry.row.ts),
			),
		]
		const result = { clineMessages: entries.map((entry) => entry.row), chatWindow }
		// Account for the byteLength field itself (normally converges in two passes).
		for (let i = 0; i < 3; i++) chatWindow.byteLength = Buffer.byteLength(JSON.stringify(result))
		return result
	}
}
