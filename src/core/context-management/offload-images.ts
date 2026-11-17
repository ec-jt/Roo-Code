import crypto from "crypto"
import type { Anthropic } from "@anthropic-ai/sdk"

import type { ApiMessage } from "../task-persistence/apiMessages"

/** Prefix of the text that replaces an offloaded image. */
export const OFFLOAD_MARKER_PREFIX = "[Image offloaded:"

/** Saves base64 image data and returns its absolute path, or undefined on failure. */
export type SaveImage = (data: string, mediaType: string, hash: string) => Promise<string | undefined>

export interface OffloadImagesResult {
	messages: ApiMessage[]
	offloadedCount: number
}

export function offloadMarker(filePath: string): string {
	return `${OFFLOAD_MARKER_PREFIX} ${filePath}. Reading it again with read_file needs approval to read outside the workspace.]`
}

export function extensionForMediaType(mediaType: string): string {
	const sub = mediaType.split("/")[1]?.toLowerCase() ?? "bin"
	if (sub === "jpeg") return "jpg"
	if (sub === "svg+xml") return "svg"
	return /^[a-z0-9]+$/.test(sub) ? sub : "bin"
}

type ImageBlock = Anthropic.Messages.ImageBlockParam

function base64Source(block: ImageBlock): { data: string; mediaType: string } | undefined {
	const source = block.source as { type?: string; data?: string; media_type?: string }
	if (source?.type !== "base64" || typeof source.data !== "string" || !source.data) return undefined
	return { data: source.data, mediaType: source.media_type ?? "image/png" }
}

/**
 * Replaces base64 image blocks in messages before `preserveFrom` with a text reference to a saved
 * file. Covers top-level image blocks and images inside tool results. Identical images are saved
 * once (keyed by SHA-256). A failed save keeps the image. The input is not mutated.
 */
export async function offloadImages(
	messages: ApiMessage[],
	preserveFrom: number,
	save: SaveImage,
): Promise<OffloadImagesResult> {
	const saved = new Map<string, string | undefined>()
	let offloadedCount = 0

	const offload = async (block: ImageBlock): Promise<Anthropic.Messages.TextBlockParam | undefined> => {
		const source = base64Source(block)
		if (!source) return undefined
		const hash = crypto.createHash("sha256").update(source.data).digest("hex")
		if (!saved.has(hash)) {
			let filePath: string | undefined
			try {
				filePath = await save(source.data, source.mediaType, hash)
			} catch {
				filePath = undefined
			}
			saved.set(hash, filePath)
		}
		const filePath = saved.get(hash)
		if (!filePath) return undefined
		offloadedCount++
		return { type: "text", text: offloadMarker(filePath) }
	}

	const result: ApiMessage[] = []
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (index >= preserveFrom || !Array.isArray(message.content)) {
			result.push(message)
			continue
		}

		let changed = false
		const content: typeof message.content = []
		for (const block of message.content) {
			if (block.type === "image") {
				const replacement = await offload(block)
				if (replacement) {
					content.push(replacement)
					changed = true
				} else {
					content.push(block)
				}
				continue
			}
			if (block.type === "tool_result" && Array.isArray(block.content)) {
				let innerChanged = false
				const inner: typeof block.content = []
				for (const part of block.content) {
					if (part.type === "image") {
						const replacement = await offload(part)
						if (replacement) {
							inner.push(replacement)
							innerChanged = true
							continue
						}
					}
					inner.push(part)
				}
				if (innerChanged) {
					content.push({ ...block, content: inner })
					changed = true
					continue
				}
			}
			content.push(block)
		}
		result.push(changed ? { ...message, content } : message)
	}

	return { messages: result, offloadedCount }
}
