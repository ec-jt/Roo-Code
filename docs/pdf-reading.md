# Native PDF reading

Roo reads PDFs with the JavaScript PDF.js engine already included in its existing pdf-parse dependency. Python and pypdf are not required for this path. PDFs are parsed as bytes, not scraped from Chromium's PDF viewer.

## Interpreting the macOS diagnostic

The reported HTTP 200 response, application/pdf content type, and 5,777,843 downloaded bytes establish that the request returned a body advertised as a PDF. They do not by themselves prove that the body is a valid PDF. A false pypdf availability result means that the selected Python environment lacks that parser. It does not mean that the PDF is invalid.

The urllib3 v2 warning about Python 3.9 with LibreSSL 2.8.3 is a separate Python TLS compatibility warning. Native Roo PDF reading does not use that Python environment. This change does not alter the macOS virtual environment, install pypdf, suppress the warning, or disable certificate verification. If that separate Python workflow is required, use a supported Python build linked to a compatible OpenSSL version and install its dependencies in the intended environment.

## Bounds and results

- Input: at most 20 MiB. The reported 5.8 MB document fits this byte limit.
- Extraction: at most 100 pages and 100,000 text characters.
- Parsing: a separate worker with a 15-second deadline and cancellation. Its V8 heap has a 128 MiB old-generation limit and a 16 MiB young-generation limit. This is not an OS sandbox or a hard total-process memory limit.
- HTTP acquisition: a 30-second overall deadline, at most five redirects, and a streamed byte limit even when Content-Length is absent or wrong.
- Limits can be lowered by callers, not raised above the hard defaults.
- Local PDF reads honor the requested line limit. If page or character limits stopped extraction, the reported total line count describes only the extracted prefix.
- Password-protected PDFs fail with a password-required message. Password entry is not implemented.
- Documents with no extractable text in the processed pages report that OCR may be required. OCR is not implemented. A blank result is not reported as successful text extraction without a warning.

PDF layout, tables, figures, fonts, and reading order can be imperfect. Image-only content needs an OCR-capable workflow. The installed parser is not upgraded by this change. Dynamic code evaluation and font rendering are disabled in the worker, but the old parser is not a security sandbox.

## Integration and authorization

The byte-only [`extractPdfBuffer()`](../src/integrations/misc/pdf-extraction.ts:44) accepts authorized bytes and optional limits and cancellation. It returns text, total document pages, pages read, a truncation flag, and an optional warning. It does not fetch URLs or read files.

The CDP-facing [`extractPdfResponse()`](../src/services/browser/pdfContent.ts:21) also takes response metadata: URL, HTTP status, and optional content type. It checks HTTP(S), requires a complete successful HTTP response, and verifies the PDF signature before parsing. A mismatched MIME type is reported as a warning only if a PDF signature exists. HTML login pages and error pages are rejected. A CDP caller must bound response acquisition before creating the buffer and must retain its normal URL/session authorization checks. The helper cannot undo an oversized allocation made by its caller.

The existing URL-to-Markdown flow uses [`fetchPdfUrl()`](../src/services/browser/pdfContent.ts:40) for explicit PDF URLs and PDF navigation responses. It makes a new credential-free request, not an authenticated browser-session replay. Cookies and authorization headers are not copied. Authenticated documents may therefore fail; this flow does not silently export browser credentials to make them work. Each redirect is checked for HTTP(S), embedded credentials are rejected, and HTTPS-to-HTTP downgrades are refused. Normal TLS verification remains enabled.

Local files continue through the existing file tools and their workspace/ignore-policy checks. The PDF helper is not a new file-authorization bypass. No document is written to disk by the remote extraction path. Downloading an arbitrary document still requires the normal tool/user authorization.

## Packaging

The parser worker source is [`pdfExtraction.worker.ts`](../src/integrations/misc/pdfExtraction.worker.ts). The 4.2.51 / Cordis preview 47 extension bundles it as dist/workers/pdfExtraction.js, next to the existing token-count worker. The runtime does not fall back to parsing untrusted bytes on the extension thread if the worker is missing. Focused tests bundle this worker into a temporary test directory and use generated PDFs; they do not access user documents or private hosts.
