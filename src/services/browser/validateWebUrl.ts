/** Local files must use the file tools and their workspace/ignore checks. */
export function validateWebUrl(value: string): void {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error("Provide an absolute HTTP or HTTPS URL.")
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs are supported. Use path for local files.")
	}
}
