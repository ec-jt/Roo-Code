const BRAVE_BASE_URL = "https://api.search.brave.com/res/v1"

export interface BraveWebSearchResult {
	title?: string
	url?: string
	description?: string
}

export function formatBraveWebSearchResponse(data: any): string {
	const results = Array.isArray(data?.web?.results) ? (data.web.results as BraveWebSearchResult[]) : []
	if (results.length === 0) {
		return "No web results found."
	}

	return results
		.slice(0, 10)
		.map((result, index) => {
			const lines = [
				`${index + 1}. ${result.title || "Untitled"}`,
				result.url || "",
				result.description || "",
			].filter(Boolean)
			return lines.join("\n")
		})
		.join("\n\n")
}

export function formatBraveLocalSearchResponse(data: any): string {
	const locations = Array.isArray(data?.locations?.results) ? data.locations.results : []
	if (locations.length > 0) {
		return locations
			.slice(0, 10)
			.map((location: any, index: number) => {
				const title = location.name || location.title || "Unknown place"
				const address = location.address || location.description || ""
				const phone = location.phone || ""
				const rating = location.rating ? `Rating: ${location.rating}` : ""
				return [
					`${index + 1}. ${title}`,
					address,
					phone,
					rating,
				]
					.filter(Boolean)
					.join("\n")
			})
			.join("\n\n")
	}

	return formatBraveWebSearchResponse(data)
}

export async function braveSearch(apiKey: string, query: string, count?: number, offset?: number): Promise<any> {
	const url = new URL(`${BRAVE_BASE_URL}/web/search`)
	url.searchParams.set("q", query)
	if (typeof count === "number") {
		url.searchParams.set("count", String(count))
	}
	if (typeof offset === "number") {
		url.searchParams.set("offset", String(offset))
	}

	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
	})

	if (!response.ok) {
		throw new Error(`Brave Search API error (${response.status}): ${await response.text()}`)
	}

	return response.json()
}
