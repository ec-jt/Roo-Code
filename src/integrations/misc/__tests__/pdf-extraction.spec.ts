import { build } from "esbuild"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { extractPdfBuffer, extractPdfFile, PDF_LIMITS } from "../pdf-extraction"
import { extractTextFromFileWithMetadata } from "../extract-text"
import { extractPdfResponse, fetchPdfUrl } from "../../../services/browser/pdfContent"

const state = vi.hoisted(() => ({ workerPath: "" }))
vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>()
	return {
		...actual,
		Worker: class extends actual.Worker {
			constructor(_filename: string, options: import("node:worker_threads").WorkerOptions) {
				super(state.workerPath, options)
			}
		},
	}
})

/** A minimal generated PDF with real offsets, no downloaded/private fixture. */
function makePdf(text = "Hello PDF", pages = 1, encrypted = false): Buffer {
	const stream = text ? `BT /F1 12 Tf 50 700 Td (${text}) Tj 0 -20 Td (Second line) Tj ET` : ""
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(" ")}] /Count ${pages} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		...Array.from(
			{ length: pages },
			() =>
				"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
		),
	]
	if (encrypted)
		objects.push(`<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`)
	let pdf = "%PDF-1.4\n"
	const offsets = [0]
	objects.forEach((object, i) => {
		offsets.push(Buffer.byteLength(pdf))
		pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
	})
	const startxref = Buffer.byteLength(pdf)
	pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
	for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ` /Encrypt ${objects.length} 0 R /ID [<00000000><00000000>]` : ""} >>\nstartxref\n${startxref}\n%%EOF\n`
	return Buffer.from(pdf)
}

describe("bounded native PDF extraction", () => {
	let directory: string
	beforeAll(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "roo-pdf-test-"))
		state.workerPath = path.join(directory, "pdfExtraction.js")
		// Exercise the same standalone bundling required by the extension, without a full build.
		await build({
			entryPoints: [path.resolve("integrations/misc/pdfExtraction.worker.ts")],
			outfile: state.workerPath,
			bundle: true,
			platform: "node",
			format: "cjs",
			logLevel: "silent",
		})
	})
	afterAll(async () => rm(directory, { recursive: true, force: true }))
	afterEach(() => vi.unstubAllGlobals())

	it("extracts a real synthetic PDF in the bundled worker", async () => {
		const result = await extractPdfBuffer(makePdf())
		expect(result).toMatchObject({ text: "Hello PDF\nSecond line", pages: 1, pagesRead: 1, truncated: false })
	})
	it("allows the reported 5,777,843 byte document size", async () => {
		const pdf = makePdf()
		const padded = Buffer.alloc(5_777_843, 32)
		pdf.copy(padded)
		expect((await extractPdfBuffer(padded)).text).toContain("Hello PDF")
	})
	it("caps characters and pages and reports truncation", async () => {
		const result = await extractPdfBuffer(makePdf("Long text", 3), { maxCharacters: 4 })
		expect(result.text).toBe("Long")
		expect(result.truncated).toBe(true)
		const pages = await extractPdfBuffer(makePdf("Hello", 3), { maxPages: 1 })
		expect(pages).toMatchObject({ pages: 3, pagesRead: 1, truncated: true })
	})
	it("rejects malformed PDFs and missing signatures", async () => {
		await expect(extractPdfBuffer(Buffer.from("%PDF-1.4\nnot a document"))).rejects.toThrow(/malformed/)
		await expect(extractPdfBuffer(Buffer.from("<html>Login</html>"))).rejects.toThrow(/signature/)
	})
	it("reports password and OCR requirements explicitly", async () => {
		await expect(extractPdfBuffer(makePdf("secret", 1, true))).rejects.toThrow(/requires a password/)
		const result = await extractPdfBuffer(makePdf(""))
		expect(result.text).toBe("")
		expect(result.warning).toMatch(/OCR/)
	})
	it("rejects oversized input, including a limit larger than the hard cap", async () => {
		await expect(extractPdfBuffer(makePdf(), { maxBytes: 10 })).rejects.toThrow(/byte limit/)
		await expect(extractPdfBuffer(Buffer.alloc(PDF_LIMITS.maxBytes + 1), { maxBytes: 99_000_000 })).rejects.toThrow(
			/byte limit/,
		)
	})
	it("terminates parsing on deadline and cancellation", async () => {
		await expect(extractPdfBuffer(makePdf(), { timeoutMs: 1 })).rejects.toThrow(/timed out/)
		const controller = new AbortController()
		const promise = extractPdfBuffer(makePdf(), { signal: controller.signal })
		controller.abort()
		await expect(promise).rejects.toThrow(/cancelled/)
	})
	it("bounds local file reads and honors the PDF line limit", async () => {
		const filePath = path.join(directory, "test.pdf")
		await writeFile(filePath, makePdf())
		await expect(extractPdfFile(filePath, { maxBytes: 10 })).rejects.toThrow(/byte limit/)
		const result = await extractTextFromFileWithMetadata(filePath, 1)
		expect(result).toMatchObject({ totalLines: 2, returnedLines: 1, wasTruncated: true, linesShown: [1, 1] })
		expect(result.content).toContain("Hello PDF")
		expect(result.content).not.toContain("Second line")
	})
	it("validates HTTP status, MIME and magic independently", async () => {
		const metadata = { url: "https://example.com/paper", status: 200, contentType: "text/plain" }
		expect((await extractPdfResponse(makePdf(), metadata)).warning).toMatch(/did not declare application\/pdf/)
		await expect(
			extractPdfResponse(Buffer.from("<html>Login</html>"), { ...metadata, contentType: "application/pdf" }),
		).rejects.toThrow(/signature/)
		await expect(extractPdfResponse(makePdf(), { ...metadata, status: 401 })).rejects.toThrow(/HTTP 401/)
		await expect(extractPdfResponse(makePdf(), { ...metadata, status: 206 })).rejects.toThrow(/complete successful/)
	})
	it("streams remote PDFs and does not forward cookies or credentials across redirects", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, { status: 302, headers: { location: "https://other.example/paper" } }),
			)
			.mockResolvedValueOnce(new Response(makePdf(), { headers: { "content-type": "application/pdf" } }))
		vi.stubGlobal("fetch", fetchMock)
		expect((await fetchPdfUrl("https://example.com/paper.pdf")).text).toContain("Hello PDF")
		expect(fetchMock).toHaveBeenCalledTimes(2)
		for (const [, options] of fetchMock.mock.calls) {
			expect(options).toMatchObject({
				redirect: "manual",
				credentials: "omit",
				headers: { Accept: "application/pdf" },
			})
			expect(Object.keys(options.headers)).toEqual(["Accept"])
		}
	})
	it.each(["file:///test.pdf", "http://example.com/paper.pdf", "https://user:secret@example.com/paper.pdf"])(
		"rejects unsafe redirects: %s",
		async (location) => {
			const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
			vi.stubGlobal("fetch", fetchMock)
			await expect(fetchPdfUrl("https://example.com/paper.pdf")).rejects.toThrow()
			expect(fetchMock).toHaveBeenCalledOnce()
		},
	)
	it("caps streamed response bytes without trusting Content-Length", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(makePdf())))
		await expect(fetchPdfUrl("https://example.com/paper.pdf", { maxBytes: 10 })).rejects.toThrow(/byte limit/)
	})
	it("rejects a login page instead of reporting an empty PDF", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("<html>Login</html>", { headers: { "content-type": "text/html" } })),
		)
		await expect(fetchPdfUrl("https://example.com/paper.pdf")).rejects.toThrow(/signature/)
	})
	it("aborts network acquisition at its overall deadline", async () => {
		vi.useFakeTimers()
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(
					(_url: string, options: RequestInit) =>
						new Promise((_resolve, reject) => {
							options.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
								once: true,
							})
						}),
				),
			)
			const rejected = expect(fetchPdfUrl("https://example.com/paper.pdf")).rejects.toThrow(/timed out/)
			await vi.advanceTimersByTimeAsync(30_000)
			await rejected
		} finally {
			vi.useRealTimers()
		}
	})
	it("reports nontext local PDFs without an offset error", async () => {
		const filePath = path.join(directory, "blank.pdf")
		await writeFile(filePath, makePdf(""))
		const result = await extractTextFromFileWithMetadata(filePath)
		expect(result).toMatchObject({ totalLines: 0, returnedLines: 0 })
		expect(result.content).toMatch(/OCR/)
		expect(result.content).not.toMatch(/offset/)
	})
})
