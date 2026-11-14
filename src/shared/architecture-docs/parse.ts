/**
 * Parser for architecture records under docs/architecture/.
 * Format: docs/architecture/RECORD-FORMAT.md.
 * Pure functions, no vscode or file-system dependencies.
 */

export const RECORD_STATUSES = ["proposed", "accepted", "rejected", "superseded"] as const
export type RecordStatus = (typeof RECORD_STATUSES)[number]

export type RecordKind = "decision" | "constraint" | "quality" | "risk"

/** Matches any architecture ID in prose. Trailing hyphens must be trimmed by the caller (see extractCitedIds). */
export const ARCHITECTURE_ID_PATTERN = /\b(Q-[A-Z]+-\d+|C-\d+|R-\d+|ADR-\d{4}-\d{2}-\d{2}-[a-z0-9-]+)\b/g

const ENTRY_HEADING = /^###\s+(C-\d+|R-\d+|Q-[A-Z]+-\d+):\s*(.*)$/
const DECISION_HEADING = /^#\s+(ADR-\d{4}-\d{2}-\d{2}-[a-z0-9-]+):\s*(.*)$/
const HEADER_LINE = /^(Status|Accepted-by|Superseded-by|Source|Last-verified|Paths):\s*(.*)$/

export interface RecordHeader {
	status?: string
	acceptedBy?: string
	supersededBy?: string
	source?: string
	lastVerified?: string
	paths: string[]
}

export interface ArchitectureRecord {
	id: string
	title: string
	kind: RecordKind
	/** File path relative to the architecture root, using forward slashes. */
	file: string
	/** 1-based line of the heading. */
	line: number
	header: RecordHeader
	/** Level-2 section titles (decision records only). */
	sections: string[]
	/** Record text without the heading and header lines. */
	body: string
}

/** Removes fenced code blocks, keeping line count stable so line numbers stay valid. */
export function stripFencedCode(text: string): string {
	const lines = text.split(/\r?\n/)
	let inFence = false
	return lines
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence
				return ""
			}
			return inFence ? "" : line
		})
		.join("\n")
}

/** Removes inline code spans. */
export function stripInlineCode(text: string): string {
	return text.replace(/`[^`\n]*`/g, "")
}

export function kindForId(id: string): RecordKind {
	if (id.startsWith("ADR-")) return "decision"
	if (id.startsWith("C-")) return "constraint"
	if (id.startsWith("Q-")) return "quality"
	return "risk"
}

function parseHeader(lines: string[], start: number): { header: RecordHeader; next: number } {
	const header: RecordHeader = { paths: [] }
	let i = start
	// Allow blank lines before the header block.
	while (i < lines.length && lines[i].trim() === "") i++
	for (; i < lines.length; i++) {
		const match = HEADER_LINE.exec(lines[i].trim())
		if (!match) break
		const [, key, rawValue] = match
		const value = rawValue.trim()
		switch (key) {
			case "Status":
				header.status = value
				break
			case "Accepted-by":
				header.acceptedBy = value
				break
			case "Superseded-by":
				header.supersededBy = value
				break
			case "Source":
				header.source = value
				break
			case "Last-verified":
				header.lastVerified = value
				break
			case "Paths":
				header.paths = value
					.split(",")
					.map((p) => p.trim())
					.filter(Boolean)
				break
		}
	}
	return { header, next: i }
}

/**
 * Parses one Markdown file. Decision files yield one record (from the level-1 heading).
 * Other files yield one record per `### <ID>: Title` heading.
 */
export function parseArchitectureFile(file: string, text: string): ArchitectureRecord[] {
	const lines = stripFencedCode(text).split("\n")
	const records: ArchitectureRecord[] = []

	for (let i = 0; i < lines.length; i++) {
		const decision = DECISION_HEADING.exec(lines[i])
		const entry = decision ? undefined : ENTRY_HEADING.exec(lines[i])
		const match = decision ?? entry
		if (!match) continue

		const { header, next } = parseHeader(lines, i + 1)
		const level = decision ? 1 : 3
		let end = next
		while (end < lines.length) {
			const heading = /^(#+)\s/.exec(lines[end])
			if (heading && heading[1].length <= level) break
			end++
		}
		const bodyLines = lines.slice(next, end)
		const sections = decision
			? bodyLines.map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter((s): s is string => !!s)
			: []

		records.push({
			id: match[1],
			title: match[2].trim(),
			kind: kindForId(match[1]),
			file,
			line: i + 1,
			header,
			sections,
			body: bodyLines.join("\n").trim(),
		})
		i = end - 1
	}

	return records
}

/** Returns architecture IDs cited in prose (outside code). */
export function extractCitedIds(text: string): string[] {
	const prose = stripInlineCode(stripFencedCode(text))
	const ids = new Set<string>()
	for (const match of prose.matchAll(ARCHITECTURE_ID_PATTERN)) {
		ids.add(match[1].replace(/-+$/, ""))
	}
	return [...ids]
}
