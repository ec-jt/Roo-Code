import { parentPort, workerData } from "node:worker_threads"
// Use the engine already shipped by pdf-parse, with explicit security options and without its error-swallowing wrapper.
// @ts-expect-error The installed pdf-parse engine does not publish TypeScript declarations.
import * as pdfjs from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js"
import type { PdfExtractionResult } from "./pdf-extraction"

interface TextItem {
	str: string
	transform: number[]
}

async function extract(): Promise<PdfExtractionResult> {
	const { buffer, maxPages, maxCharacters } = workerData as {
		buffer: Uint8Array
		maxPages: number
		maxCharacters: number
	}
	pdfjs.PDFJS.disableWorker = true
	pdfjs.PDFJS.isEvalSupported = false
	pdfjs.PDFJS.disableFontFace = true
	const document = await pdfjs.getDocument({
		data: new Uint8Array(buffer),
		isEvalSupported: false,
		disableFontFace: true,
		verbosity: 0,
	})
	try {
		let text = ""
		let pagesRead = 0
		let truncated = document.numPages > maxPages
		pageLoop: for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, maxPages); pageNumber++) {
			const page = await document.getPage(pageNumber)
			try {
				const content = await page.getTextContent({ normalizeWhitespace: false })
				pagesRead++
				let lastY: number | undefined
				for (const item of content.items as TextItem[]) {
					if (typeof item.str !== "string") continue
					const separator =
						lastY === undefined ? (text ? "\n\n" : "") : lastY !== item.transform[5] ? "\n" : ""
					const remaining = maxCharacters - text.length
					const piece = separator + item.str
					text += piece.slice(0, remaining)
					if (piece.length > remaining) {
						truncated = true
						break pageLoop
					}
					lastY = item.transform[5]
				}
			} finally {
				page.cleanup()
			}
		}
		const warnings: string[] = []
		if (!text.trim())
			warnings.push("No extractable text was found in the processed pages. This PDF may require OCR.")
		if (truncated) warnings.push("PDF extraction was truncated at the page or character limit.")
		return { text, pages: document.numPages, pagesRead, truncated, warning: warnings.join(" ") || undefined }
	} finally {
		await document.destroy()
	}
}

void extract().then(
	(result) => parentPort?.postMessage({ result }),
	(error: unknown) => {
		const name = error && typeof error === "object" && "name" in error ? error.name : ""
		parentPort?.postMessage({
			error:
				name === "PasswordException"
					? "This PDF requires a password. Supply an authorized decrypted copy; password entry is not supported."
					: "PDF extraction failed: malformed, unsupported, or unreadable PDF.",
		})
	},
)
