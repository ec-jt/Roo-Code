import { extractPdfBuffer, PDF_LIMITS, pdfLimit } from "../../integrations/misc/pdf-extraction"
import type { PdfExtractionOptions, PdfExtractionResult } from "../../integrations/misc/pdf-extraction"
import { validateWebUrl } from "./validateWebUrl"

export interface PdfResponseMetadata {
	url: string
	status: number
	contentType?: string
}

export function isPdfContentType(contentType: string | undefined): boolean {
	return contentType?.split(";", 1)[0].trim().toLowerCase() === "application/pdf"
}

export function isPdfUrl(url: string): boolean {
	return new URL(url).pathname.toLowerCase().endsWith(".pdf")
}

/** For already-authorized CDP response bytes. This helper never fetches or reads files. */
export async function extractPdfResponse(
	buffer: Uint8Array,
	metadata: PdfResponseMetadata,
	options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
	validateWebUrl(metadata.url)
	if (metadata.status < 200 || metadata.status >= 300 || metadata.status === 206) {
		throw new Error(`PDF request failed with HTTP ${metadata.status}; a complete successful response is required.`)
	}
	const result = await extractPdfBuffer(buffer, options)
	if (!isPdfContentType(metadata.contentType)) {
		result.warning = ["Response did not declare application/pdf; PDF signature was verified.", result.warning]
			.filter(Boolean)
			.join(" ")
	}
	return result
}

/** Only for the existing authorized URL-content flow. Never copies browser cookies or authentication headers. */
export async function fetchPdfUrl(url: string, options: PdfExtractionOptions = {}): Promise<PdfExtractionResult> {
	const maxBytes = pdfLimit(options.maxBytes, PDF_LIMITS.maxBytes)
	options.signal?.throwIfAborted()
	const controller = new AbortController()
	const onAbort = () => controller.abort()
	options.signal?.addEventListener("abort", onAbort, { once: true })
	if (options.signal?.aborted) controller.abort()
	const timer = setTimeout(() => controller.abort(), 30_000)
	try {
		let current = url
		for (let redirects = 0; redirects <= 5; redirects++) {
			validateWebUrl(current)
			const parsed = new URL(current)
			if (parsed.username || parsed.password) throw new Error("PDF URLs must not contain credentials.")
			const response = await fetch(current, {
				redirect: "manual",
				credentials: "omit",
				signal: controller.signal,
				headers: { Accept: "application/pdf" },
			})
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel()
				const location = response.headers.get("location")
				if (!location) throw new Error("PDF redirect has no destination.")
				const next = new URL(location, current)
				validateWebUrl(next.href)
				if (parsed.protocol === "https:" && next.protocol !== "https:") {
					throw new Error("PDF redirect to insecure HTTP was refused.")
				}
				current = next.href
				continue
			}
			if (!response.ok || response.status === 206) {
				await response.body?.cancel()
				throw new Error(
					`PDF request failed with HTTP ${response.status}; a complete successful response is required.`,
				)
			}
			if (Number(response.headers.get("content-length")) > maxBytes) {
				await response.body?.cancel()
				throw new Error("PDF exceeds the byte limit (maximum 20 MiB).")
			}
			if (!response.body) throw new Error("PDF response has no body.")
			const reader = response.body.getReader()
			const chunks: Uint8Array[] = []
			let total = 0
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					total += value.byteLength
					if (total > maxBytes) throw new Error("PDF exceeds the byte limit (maximum 20 MiB).")
					chunks.push(value)
				}
			} finally {
				await reader.cancel().catch(() => {})
				reader.releaseLock()
			}
			return await extractPdfResponse(
				Buffer.concat(chunks, total),
				{
					url: current,
					status: response.status,
					contentType: response.headers.get("content-type") ?? undefined,
				},
				{ ...options, signal: controller.signal },
			)
		}
		throw new Error("PDF request exceeded the redirect limit.")
	} catch (error) {
		if (controller.signal.aborted) throw new Error("PDF request cancelled or timed out.")
		// Fetch failures may include a credential-bearing URL or platform-specific certificate details.
		if (error instanceof TypeError)
			throw new Error("PDF request failed. Check the URL, network, and TLS trust configuration.")
		throw error
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", onAbort)
	}
}

export function formatPdfText(result: PdfExtractionResult): string {
	return `${result.text}${result.warning ? `\n\n[${result.warning}]` : ""}`
}
