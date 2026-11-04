import { open } from "node:fs/promises"
import * as path from "node:path"
import { Worker } from "node:worker_threads"

export const PDF_LIMITS = Object.freeze({
	maxBytes: 20 * 1024 * 1024,
	maxPages: 100,
	maxCharacters: 100_000,
	timeoutMs: 15_000,
})

export interface PdfExtractionOptions {
	/** Limits may be lowered, but not raised above PDF_LIMITS. */
	maxBytes?: number
	maxPages?: number
	maxCharacters?: number
	timeoutMs?: number
	signal?: AbortSignal
}

export interface PdfExtractionResult {
	text: string
	/** Total document pages, not just the extracted pages. */
	pages: number
	pagesRead: number
	truncated: boolean
	warning?: string
}

export function pdfLimit(value: number | undefined, ceiling: number): number {
	if (value === undefined) return ceiling
	if (!Number.isSafeInteger(value) || value < 1) throw new Error("PDF limits must be positive integers.")
	return Math.min(value, ceiling)
}

export function hasPdfSignature(buffer: Uint8Array): boolean {
	return /^\s*%PDF-\d\.\d/.test(Buffer.from(buffer.subarray(0, 1024)).toString("latin1"))
}

/** No I/O or authorization decisions: callers must authorize acquisition of the bytes first. */
export async function extractPdfBuffer(
	buffer: Uint8Array,
	options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
	options.signal?.throwIfAborted()
	if (buffer.byteLength > pdfLimit(options.maxBytes, PDF_LIMITS.maxBytes)) {
		throw new Error("PDF exceeds the byte limit (maximum 20 MiB).")
	}
	if (!hasPdfSignature(buffer)) throw new Error("Response is not a PDF: missing PDF signature.")
	const maxPages = pdfLimit(options.maxPages, PDF_LIMITS.maxPages)
	const maxCharacters = pdfLimit(options.maxCharacters, PDF_LIMITS.maxCharacters)
	const timeoutMs = pdfLimit(options.timeoutMs, PDF_LIMITS.timeoutMs)

	// A separate bundle is required: parsing untrusted input on the extension thread cannot be timed out.
	const worker = new Worker(path.join(__dirname, "workers/pdfExtraction.js"), {
		workerData: { buffer: new Uint8Array(buffer), maxPages, maxCharacters },
		resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
		// Do not forward document-controlled parser diagnostics to extension logs.
		stdout: true,
		stderr: true,
	})
	worker.stdout?.resume()
	worker.stderr?.resume()
	try {
		return await new Promise<PdfExtractionResult>((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error("PDF extraction timed out.")), timeoutMs)
			const onAbort = () => finish(new Error("PDF extraction cancelled."))
			const finish = (error?: Error, result?: PdfExtractionResult) => {
				clearTimeout(timer)
				options.signal?.removeEventListener("abort", onAbort)
				if (error) reject(error)
				else resolve(result!)
			}
			worker.once("message", (message: { result?: PdfExtractionResult; error?: string }) => {
				if (message.result) finish(undefined, message.result)
				else finish(new Error(message.error || "PDF extraction failed."))
			})
			worker.once("error", () => finish(new Error("PDF parser worker failed or exceeded its memory limit.")))
			worker.once("exit", () => finish(new Error("PDF parser worker exited without a result.")))
			options.signal?.addEventListener("abort", onAbort, { once: true })
			if (options.signal?.aborted) onAbort()
		})
	} finally {
		await worker.terminate()
	}
}

/** Only call after the file tool's existing workspace and ignore-policy checks. */
export async function extractPdfFile(
	filePath: string,
	options: PdfExtractionOptions = {},
): Promise<PdfExtractionResult> {
	options.signal?.throwIfAborted()
	const maxBytes = pdfLimit(options.maxBytes, PDF_LIMITS.maxBytes)
	const file = await open(filePath, "r")
	let buffer: Buffer
	try {
		const stat = await file.stat()
		if (!stat.isFile()) throw new Error("PDF input must be a regular file.")
		if (stat.size > maxBytes) throw new Error("PDF exceeds the byte limit (maximum 20 MiB).")
		const chunks: Buffer[] = []
		let total = 0
		while (true) {
			options.signal?.throwIfAborted()
			const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total))
			const { bytesRead } = await file.read(chunk)
			if (!bytesRead) break
			total += bytesRead
			if (total > maxBytes) throw new Error("PDF exceeds the byte limit (maximum 20 MiB).")
			chunks.push(chunk.subarray(0, bytesRead))
		}
		buffer = Buffer.concat(chunks, total)
	} finally {
		await file.close()
	}
	return extractPdfBuffer(buffer, options)
}
