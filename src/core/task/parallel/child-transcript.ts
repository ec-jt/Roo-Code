import type { ClineMessage } from "@roo-code/types"

import { chatMessageText } from "../../../shared/chat-preview"

/**
 * Plain-text, read-only transcript of a parallel child for "Open" in Background activity
 * (ADR-2026-11-22-parallel-subtasks rule 6). It is shown in a read-only native document
 * (ChatHistoryDocument); it never crosses the webview bridge and is never written to disk.
 * Images and reasoning are left out.
 */
export function formatParallelChildTranscript(messages: readonly ClineMessage[]): string {
	const parts: string[] = []
	for (const message of messages) {
		if (message.partial) continue
		const kind = message.type === "ask" ? `ask: ${message.ask}` : `say: ${message.say}`
		if (message.type === "say" && message.say === "api_req_started") continue
		const text = chatMessageText(message)?.trim()
		if (!text) continue
		parts.push(`[${new Date(message.ts).toISOString()}] ${kind}\n${text}`)
	}
	return parts.length ? parts.join("\n\n") : "This subtask has no messages yet."
}
