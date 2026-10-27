import { createHash } from "node:crypto"
import type Anthropic from "@anthropic-ai/sdk"
import type { ApiMessage } from "../../core/task-persistence/apiMessages"

export const stateHash = (value: string): string => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
	if (value && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`
	return JSON.stringify(value)
}

/** Only complete digest-checked generated blocks are omitted, never arbitrary user mentions. */
export function isGeneratedRecall(text: string): boolean {
	const match = /^<(roo_task_state|roo_memory_context) version="1" digest="([a-f0-9]{64})">\n([\s\S]*)\n<\/\1>$/.exec(
		text,
	)
	return !!match && stateHash(match[3]) === match[2]
}

export function taskHistoryAnchors(messages: readonly ApiMessage[]) {
	const anchors = [stateHash("roo-task-state-history-v1")]
	for (const message of messages) {
		if (message.isSummary || message.isTruncationMarker) continue
		const content = Array.isArray(message.content)
			? message.content.filter((block) => block.type !== "text" || !isGeneratedRecall(block.text))
			: message.content
		if (Array.isArray(content) && !content.length) continue
		anchors.push(stateHash(`${anchors.at(-1)}\n${canonical({ role: message.role, content })}`))
	}
	return { anchors, anchor: anchors.at(-1)!, position: anchors.length - 1 }
}

export function taskStateRecall(body: string): string {
	return body ? `<roo_task_state version="1" digest="${stateHash(body)}">\n${body}\n</roo_task_state>` : ""
}

/** Revoked recall must not leak from older ordinary turns. Prepared replay never calls this. */
export function withoutTaskStateRecall(messages: readonly ApiMessage[]): ApiMessage[] {
	return messages
		.map((message) =>
			Array.isArray(message.content)
				? {
						...message,
						content: message.content.filter(
							(block) =>
								block.type !== "text" ||
								!block.text.startsWith("<roo_task_state ") ||
								!isGeneratedRecall(block.text),
						),
					}
				: message,
		)
		.filter((message) => !Array.isArray(message.content) || message.content.length > 0)
}

export function appendTaskStateRecall(
	content: Anthropic.Messages.ContentBlockParam[],
	recall: string,
	history: readonly Anthropic.MessageParam[],
): Anthropic.Messages.ContentBlockParam[] {
	if (!recall) return content
	for (const message of [...history].reverse()) {
		if (!Array.isArray(message.content)) continue
		for (const block of [...message.content].reverse()) {
			if (block.type === "text" && block.text.startsWith("<roo_task_state ") && isGeneratedRecall(block.text)) {
				if (block.text === recall) return content
				return [...content, { type: "text", text: recall }]
			}
		}
	}
	return [...content, { type: "text", text: recall }]
}
