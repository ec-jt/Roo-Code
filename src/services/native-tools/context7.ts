const CONTEXT7_BASE_URL = "https://context7.com/api"

export function formatContext7SearchResponse(data: any): string {
	const results = Array.isArray(data?.results) ? data.results : []
	if (results.length === 0) {
		return "No matching libraries found."
	}

	return results
		.slice(0, 10)
		.map((result: any, index: number) => {
			return [
				`${index + 1}. ${result.title || result.id || "Unknown library"}`,
				`ID: ${result.id || "unknown"}`,
				result.description || "",
				result.benchmarkScore !== undefined ? `Benchmark score: ${result.benchmarkScore}` : "",
				result.trustScore !== undefined ? `Trust score: ${result.trustScore}` : "",
			]
				.filter(Boolean)
				.join("\n")
		})
		.join("\n\n")
}

export function formatContext7DocsResponse(data: any): string {
	if (typeof data === "string") {
		return data
	}

	const codeSnippets = Array.isArray(data?.codeSnippets) ? data.codeSnippets : []
	const infoSnippets = Array.isArray(data?.infoSnippets) ? data.infoSnippets : []

	const codeText = codeSnippets
		.slice(0, 10)
		.map((snippet: any, index: number) => {
			const code = Array.isArray(snippet.codeList)
				? snippet.codeList.map((item: any) => item.code).filter(Boolean).join("\n\n")
				: ""
			return [
				`### Code Snippet ${index + 1}: ${snippet.codeTitle || "Untitled"}`,
				snippet.pageTitle ? `Page: ${snippet.pageTitle}` : "",
				snippet.codeDescription || "",
				code ? `\n\`\`\`\n${code}\n\`\`\`` : "",
			]
				.filter(Boolean)
				.join("\n")
		})
		.join("\n\n")

	const infoText = infoSnippets
		.slice(0, 10)
		.map((snippet: any, index: number) => {
			return [
				`### Documentation ${index + 1}`,
				snippet.breadcrumb || "",
				snippet.content || "",
			]
				.filter(Boolean)
				.join("\n")
		})
		.join("\n\n")

	return [codeText, infoText].filter(Boolean).join("\n\n") || "No documentation context found."
}

async function parseContext7Response(response: Response): Promise<any> {
	const contentType = response.headers.get("content-type") || ""
	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Context7 API error (${response.status}): ${errorText}`)
	}

	if (contentType.includes("application/json")) {
		return response.json()
	}

	return response.text()
}

export async function context7ResolveLibraryId(apiKey: string, libraryName: string, query: string): Promise<any> {
	const url = new URL(`${CONTEXT7_BASE_URL}/v2/libs/search`)
	url.searchParams.set("libraryName", libraryName)
	url.searchParams.set("query", query)

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
	})

	return parseContext7Response(response)
}

export async function context7QueryDocs(apiKey: string, libraryId: string, query: string): Promise<any> {
	const url = new URL(`${CONTEXT7_BASE_URL}/v2/context`)
	url.searchParams.set("libraryId", libraryId)
	url.searchParams.set("query", query)
	url.searchParams.set("type", "json")

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
	})

	return parseContext7Response(response)
}
