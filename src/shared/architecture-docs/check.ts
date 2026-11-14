import * as fs from "fs/promises"
import * as path from "path"

import {
	type ArchitectureRecord,
	RECORD_STATUSES,
	extractCitedIds,
	parseArchitectureFile,
	stripFencedCode,
	stripInlineCode,
} from "./parse"

export type ApprovalPolicy = "user" | "agent"

export interface CheckIssue {
	severity: "error" | "warning"
	file: string
	line?: number
	message: string
}

export interface CheckOptions {
	approval?: ApprovalPolicy
	now?: Date
	staleDays?: number
}

export interface CheckResult {
	records: ArchitectureRecord[]
	issues: CheckIssue[]
	errorCount: number
	warningCount: number
}

const INDEX_FILE = "arc42.md"
const DAY_MS = 24 * 60 * 60 * 1000

const REQUIRED_SECTIONS: Record<string, string[]> = {
	proposed: ["Problem", "Proposal", "Alternatives considered", "Acceptance criteria", "Risks"],
	accepted: ["Problem", "Decision", "Alternatives considered", "Consequences"],
	rejected: ["Problem", "Decision", "Alternatives considered", "Consequences"],
	superseded: ["Problem", "Decision", "Alternatives considered", "Consequences"],
}

async function listMarkdownFiles(root: string, dir = root): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true })
	const files: string[] = []
	for (const entry of entries) {
		const full = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await listMarkdownFiles(root, full)))
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(full)
		}
	}
	return files.sort()
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p)
		return true
	} catch {
		return false
	}
}

function toRel(root: string, file: string): string {
	return path.relative(root, file).split(path.sep).join("/")
}

function lineOf(text: string, index: number): number {
	return text.slice(0, index).split("\n").length
}

/** Validates docs/architecture/ against RECORD-FORMAT.md. */
export async function checkArchitectureDocs(root: string, options: CheckOptions = {}): Promise<CheckResult> {
	const approval = options.approval ?? "user"
	const now = options.now ?? new Date()
	const staleDays = options.staleDays ?? 180
	const issues: CheckIssue[] = []
	const error = (file: string, message: string, line?: number) =>
		issues.push({ severity: "error", file, line, message })
	const warn = (file: string, message: string, line?: number) =>
		issues.push({ severity: "warning", file, line, message })

	if (!(await exists(path.join(root, INDEX_FILE)))) {
		error(INDEX_FILE, `Index file ${INDEX_FILE} not found in ${root}`)
		return { records: [], issues, errorCount: 1, warningCount: 0 }
	}

	const files = await listMarkdownFiles(root)
	const texts = new Map<string, string>()
	const records: ArchitectureRecord[] = []

	for (const file of files) {
		const rel = toRel(root, file)
		const text = await fs.readFile(file, "utf8")
		texts.set(rel, text)
		records.push(...parseArchitectureFile(rel, text))

		// Relative links must resolve.
		const prose = stripInlineCode(stripFencedCode(text))
		for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
			const target = match[1].split("#")[0]
			if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
			if (!(await exists(path.resolve(path.dirname(file), target)))) {
				error(rel, `Broken link: ${match[1]}`, lineOf(prose, match.index ?? 0))
			}
		}
	}

	// Unique IDs.
	const byId = new Map<string, ArchitectureRecord>()
	for (const record of records) {
		const previous = byId.get(record.id)
		if (previous) {
			error(record.file, `Duplicate ID ${record.id} (first defined in ${previous.file}:${previous.line})`, record.line)
		} else {
			byId.set(record.id, record)
		}
	}

	for (const record of records) {
		const { header, file, line, id } = record
		const status = header.status

		if (!status) {
			error(file, `${id}: missing Status`, line)
		} else if (!(RECORD_STATUSES as readonly string[]).includes(status)) {
			error(file, `${id}: invalid Status "${status}"`, line)
		}

		if (record.kind === "decision") {
			const parts = file.split("/")
			const base = parts[parts.length - 1].replace(/\.md$/, "")
			if (base !== id) {
				error(file, `${id}: file name must be ${id}.md`, line)
			}
			const folder = parts.length >= 3 && parts[parts.length - 3] === "decisions" ? parts[parts.length - 2] : undefined
			if (!folder) {
				error(file, `${id}: decision records must be in decisions/<status>/`, line)
			} else if (status && folder !== status) {
				error(file, `${id}: folder "${folder}" does not match Status "${status}"`, line)
			}
			const required = status ? REQUIRED_SECTIONS[status] : undefined
			for (const section of required ?? []) {
				if (!record.sections.includes(section)) {
					error(file, `${id}: missing section "## ${section}" required for status ${status}`, line)
				}
			}
		}

		if (status === "accepted") {
			if (!header.acceptedBy) {
				error(file, `${id}: accepted records need Accepted-by`, line)
			} else if (/^agent\b/.test(header.acceptedBy)) {
				if (approval === "user") {
					error(file, `${id}: Accepted-by agent is not allowed with --approval user`, line)
				} else if (!/^agent \(task [^)\s]+\)$/.test(header.acceptedBy)) {
					error(file, `${id}: Accepted-by agent must be "agent (task <taskId>)"`, line)
				}
			} else if (header.acceptedBy !== "user") {
				error(file, `${id}: invalid Accepted-by "${header.acceptedBy}"`, line)
			}
		}

		if (status === "superseded") {
			if (!header.supersededBy) {
				error(file, `${id}: superseded records need Superseded-by`, line)
			} else if (!byId.has(header.supersededBy)) {
				error(file, `${id}: Superseded-by ${header.supersededBy} does not resolve`, line)
			}
		}

		if (header.source) {
			warn(file, `${id}: Source: ${header.source} (unconfirmed content)`, line)
		}

		if (!header.lastVerified) {
			error(file, `${id}: missing Last-verified`, line)
		} else {
			const verified = /^\d{4}-\d{2}-\d{2}$/.test(header.lastVerified)
				? Date.parse(`${header.lastVerified}T00:00:00Z`)
				: NaN
			if (Number.isNaN(verified)) {
				error(file, `${id}: invalid Last-verified "${header.lastVerified}"`, line)
			} else if (now.getTime() - verified > staleDays * DAY_MS) {
				warn(file, `${id}: Last-verified ${header.lastVerified} is older than ${staleDays} days`, line)
			}
		}
	}

	// Every cited ID must resolve. RECORD-FORMAT.md only shows examples.
	for (const [rel, text] of texts) {
		if (rel === "RECORD-FORMAT.md") continue
		for (const cited of extractCitedIds(text)) {
			if (!byId.has(cited)) {
				error(rel, `Cited ID ${cited} does not resolve`)
			}
		}
	}

	const errorCount = issues.filter((i) => i.severity === "error").length
	return { records, issues, errorCount, warningCount: issues.length - errorCount }
}

export function formatIssue(issue: CheckIssue): string {
	const location = issue.line ? `${issue.file}:${issue.line}` : issue.file
	return `${issue.severity}: ${location}: ${issue.message}`
}
