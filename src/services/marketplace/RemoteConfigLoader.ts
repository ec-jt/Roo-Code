import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"
import { z } from "zod"

import {
	type MarketplaceItem,
	type MarketplaceItemType,
	modeMarketplaceItemSchema,
	mcpMarketplaceItemSchema,
} from "@roo-code/types"

/**
 * Bundled marketplace data file path.
 * Since the upstream Roo Code Cloud and Cline marketplace APIs are no longer available,
 * we bundle marketplace data locally from a YAML file extracted from Cline's catalog.
 */
const BUNDLED_MCPS_FILENAME = "bundled-mcps.yaml"

const modeMarketplaceResponse = z.object({
	items: z.array(modeMarketplaceItemSchema),
})

const mcpMarketplaceResponse = z.object({
	items: z.array(mcpMarketplaceItemSchema),
})

export class RemoteConfigLoader {
	private cache: Map<string, { data: MarketplaceItem[]; timestamp: number }> = new Map()
	private cacheDuration = 5 * 60 * 1000 // 5 minutes

	constructor() {}

	async loadAllItems(hideMarketplaceMcps = false): Promise<MarketplaceItem[]> {
		const items: MarketplaceItem[] = []

		const modesPromise = this.fetchModes()
		const mcpsPromise = hideMarketplaceMcps ? Promise.resolve([]) : this.fetchMcps()

		const [modes, mcps] = await Promise.all([modesPromise, mcpsPromise])

		items.push(...modes, ...mcps)
		return items
	}

	private async fetchModes(): Promise<MarketplaceItem[]> {
		const cacheKey = "modes"
		const cached = this.getFromCache(cacheKey)

		if (cached) {
			return cached
		}

		// No bundled modes file yet - return empty
		// Custom modes are managed via .roomodes files
		const items: MarketplaceItem[] = []
		this.setCache(cacheKey, items)
		return items
	}

	private async fetchMcps(): Promise<MarketplaceItem[]> {
		const cacheKey = "mcps"
		const cached = this.getFromCache(cacheKey)

		if (cached) {
			return cached
		}

		try {
			const items = await this.loadBundledMcps()
			this.setCache(cacheKey, items)
			return items
		} catch (error) {
			console.error("Failed to load bundled MCPs:", error)
			return []
		}
	}

	/**
	 * Load MCP marketplace items from the bundled YAML file.
	 * This file was extracted from Cline's marketplace catalog.
	 */
	private async loadBundledMcps(): Promise<MarketplaceItem[]> {
		// Try multiple possible locations for the bundled file
		const possiblePaths = [
			// When running as extension (dist directory)
			path.join(__dirname, BUNDLED_MCPS_FILENAME),
			// When running from source
			path.join(__dirname, "..", "..", "services", "marketplace", BUNDLED_MCPS_FILENAME),
			// Relative to this file's source location
			path.resolve(__dirname, BUNDLED_MCPS_FILENAME),
		]

		let yamlContent: string | null = null

		for (const filePath of possiblePaths) {
			try {
				yamlContent = fs.readFileSync(filePath, "utf-8")
				break
			} catch {
				continue
			}
		}

		if (!yamlContent) {
			console.warn(`Bundled MCPs file not found in any of: ${possiblePaths.join(", ")}`)
			return []
		}

		const yamlData = yaml.parse(yamlContent)

		if (!yamlData?.items || !Array.isArray(yamlData.items)) {
			console.warn("Bundled MCPs file has invalid format")
			return []
		}

		const items: MarketplaceItem[] = []

		for (const rawItem of yamlData.items) {
			try {
				// Validate against the MCP marketplace item schema
				const validated = mcpMarketplaceItemSchema.parse(rawItem)
				items.push({
					type: "mcp" as const,
					...validated,
				})
			} catch (error) {
				// Skip invalid items silently
				continue
			}
		}

		return items
	}

	async getItem(id: string, type: MarketplaceItemType): Promise<MarketplaceItem | null> {
		const items = await this.loadAllItems()
		return items.find((item) => item.id === id && item.type === type) || null
	}

	private getFromCache(key: string): MarketplaceItem[] | null {
		const cached = this.cache.get(key)
		if (!cached) return null

		const now = Date.now()
		if (now - cached.timestamp > this.cacheDuration) {
			this.cache.delete(key)
			return null
		}

		return cached.data
	}

	private setCache(key: string, data: MarketplaceItem[]): void {
		this.cache.set(key, {
			data,
			timestamp: Date.now(),
		})
	}

	clearCache(): void {
		this.cache.clear()
	}
}
