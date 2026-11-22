/**
 * Pure helpers for scripts/eval-protocol.ts (developer tooling, not shipped in the VSIX).
 * ADR-2026-11-20-feature-gating-evaluation-and-lessons, R-6.
 *
 * Ideas taken from Harness² (google-research/harness2, commit 6868817), not its code:
 * - leak check: `assert_no_leak_paths` (core/context.py);
 * - matrix check: `Ledger.assert_identity` (core/ledger.py) and run fingerprints (core/runmark.py);
 * - blind review: anonymous candidates and a separate judge (core/selection.py).
 *
 * Nothing here reads files, environment variables or the network. IO lives in the CLI.
 */

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

/** Lines of the markdown section whose level-2 heading starts with the given number (for example "4"). */
export function extractSection(markdown: string, sectionNumber: string): string[] {
	const lines = markdown.split(/\r?\n/)
	const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(sectionNumber)}[.\\s]`).test(line))
	if (start < 0) return []
	const rest = lines.slice(start + 1)
	const end = rest.findIndex((line) => /^##\s/.test(line))
	return end < 0 ? rest : rest.slice(0, end)
}

/** Blockquotes, joined per block. Consecutive `>` lines form one block. */
function extractBlockquotes(lines: string[]): string[] {
	const blocks: string[] = []
	let current: string[] = []
	const flush = () => {
		const text = current.join(" ").replace(/\s+/g, " ").trim()
		if (text) blocks.push(text)
		current = []
	}
	for (const line of lines) {
		const match = /^\s*>\s?(.*)$/.exec(line)
		if (match) {
			current.push(match[1] ?? "")
		} else {
			flush()
		}
	}
	flush()
	return blocks
}

/** Italic quoted strings: `_"..."_` or `*"..."*`. */
function extractItalicQuotes(lines: string[]): string[] {
	const result: string[] = []
	const pattern = /(?:_"([^"]+)"_)|(?:\*"([^"]+)"\*)/g
	for (const line of lines) {
		for (const match of line.matchAll(pattern)) {
			const text = (match[1] ?? match[2] ?? "").trim()
			if (text) result.push(text)
		}
	}
	return result
}

/**
 * Scripted strings of the protocol: the blockquotes (prompts) and italic quoted lines (scripted
 * replies) of section 4. Each string also yields a variant without Markdown backticks, because the
 * prompt is pasted as plain text. Duplicates are removed; order is stable.
 */
export function extractScriptedStrings(markdown: string, sectionNumber = "4"): string[] {
	const lines = extractSection(markdown, sectionNumber)
	const raw = [...extractBlockquotes(lines), ...extractItalicQuotes(lines)]
	const result: string[] = []
	for (const text of raw) {
		for (const variant of [text, text.replace(/`/g, "")]) {
			if (variant.length >= 8 && !result.includes(variant)) result.push(variant)
		}
	}
	return result
}

/** Task prompt of one scenario: the first blockquote under the `### <scenario>` heading in section 4. */
export function extractScenarioPrompt(markdown: string, scenario: string, sectionNumber = "4"): string | undefined {
	const lines = extractSection(markdown, sectionNumber)
	const start = lines.findIndex((line) => new RegExp(`^###\\s+${escapeRegExp(scenario)}\\b`).test(line))
	if (start < 0) return undefined
	const rest = lines.slice(start + 1)
	const end = rest.findIndex((line) => /^###\s/.test(line))
	const body = end < 0 ? rest : rest.slice(0, end)
	return extractBlockquotes(body)[0]
}

/** Lines of an extra strings file. Blank lines and lines starting with `#` are ignored. */
export function parseExtraStrings(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
}

// ---------------------------------------------------------------------------
// Leak scanning
// ---------------------------------------------------------------------------

export interface Needle {
	kind: "protocol-file-name" | "scripted-string" | "extra-string" | "forbidden-line" | "forbidden-file-name"
	text: string
}

export interface LeakHit {
	/** For example a relative file path, or `git diff HEAD` / `git log -p <sha>` with the file it touches. */
	source: string
	/** 1-based line number inside the source (file line, or line inside the diff or patch). 0 for a path hit. */
	line: number
	needle: Needle
}

export function buildNeedles(protocolFileName: string, scripted: string[], extra: string[]): Needle[] {
	const needles: Needle[] = [{ kind: "protocol-file-name", text: protocolFileName }]
	const seen = new Set([protocolFileName])
	for (const text of scripted) {
		if (!seen.has(text)) {
			seen.add(text)
			needles.push({ kind: "scripted-string", text })
		}
	}
	for (const text of extra) {
		if (!seen.has(text)) {
			seen.add(text)
			needles.push({ kind: "extra-string", text })
		}
	}
	return needles
}

/** Needles found in one line. Case-sensitive substring match. */
export function matchLine(line: string, needles: Needle[]): Needle[] {
	return needles.filter((needle) => line.includes(needle.text))
}

/** Hits in a block of text, one per needle per line. */
export function scanText(source: string, text: string, needles: Needle[]): LeakHit[] {
	const hits: LeakHit[] = []
	const lines = text.split(/\r?\n/)
	lines.forEach((line, index) => {
		for (const needle of matchLine(line, needles)) hits.push({ source, line: index + 1, needle })
	})
	return hits
}

/** Path hits: a file whose relative path contains a needle (normally the protocol file name). */
export function scanPath(relativePath: string, needles: Needle[]): LeakHit[] {
	return matchLine(relativePath, needles).map((needle) => ({ source: relativePath, line: 0, needle }))
}

/** Directories never walked by the leak check. */
export const LEAK_SKIP_DIRECTORIES = new Set(["node_modules", ".git"])

/**
 * Minimum trimmed length of a line from a `--forbid` file before it counts as distinctive. Short lines
 * such as `assert.equal(r.status, 200)` are common in any test suite and would give false hits.
 */
export const FORBID_MIN_LINE_LENGTH = 32

/** Lines that are common in any Node project, so they never count as distinctive. Compared after trimming. */
const COMMON_LINES = new Set([
	'import assert from "node:assert/strict"',
	'import { test } from "node:test"',
	'import { describe, it } from "node:test"',
	"import assert from 'node:assert/strict'",
	"import { test } from 'node:test'",
	'"type": "module",',
	'"private": true,',
	'"start": "node server.mjs",',
	"} catch (error) {",
])

/** File names that are too generic to count as a `--forbid` file-name hit. */
export const FORBID_GENERIC_FILE_NAMES = new Set([
	"package.json",
	"package-lock.json",
	"README.md",
	".gitignore",
	"tsconfig.json",
	"index.js",
	"index.mjs",
	"index.ts",
	"server.js",
	"server.mjs",
	"server.ts",
	"lib.mjs",
	"lib.js",
	"lib.ts",
	"lib.test.mjs",
])

/**
 * Distinctive lines of a forbidden file: trimmed lines of at least `FORBID_MIN_LINE_LENGTH` characters
 * that contain a letter, are not import statements, and are not in the common-lines list. Duplicates are
 * removed; order is stable.
 */
export function distinctiveLines(text: string, minLength = FORBID_MIN_LINE_LENGTH): string[] {
	const result: string[] = []
	const seen = new Set<string>()
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (line.length < minLength || !/\p{L}/u.test(line)) continue
		if (/^import\s/.test(line) || COMMON_LINES.has(line) || seen.has(line)) continue
		seen.add(line)
		result.push(line)
	}
	return result
}

/** A path hit when the file's base name equals a forbidden file name (generic names are ignored). */
export function scanForbiddenName(relativePath: string, names: ReadonlySet<string>): LeakHit[] {
	const base = relativePath.split("/").pop() ?? relativePath
	if (!names.has(base) || FORBID_GENERIC_FILE_NAMES.has(base)) return []
	return [{ source: relativePath, line: 0, needle: { kind: "forbidden-file-name", text: base } }]
}

/** True when a buffer looks binary (contains a NUL byte in its first 8000 bytes). */
export function looksBinary(buffer: Uint8Array): boolean {
	const limit = Math.min(buffer.length, 8000)
	for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true
	return false
}

/**
 * Tracks the current commit and file while reading `git log -p` or `git diff` output line by line,
 * so each hit can name where it came from.
 */
export class PatchCursor {
	private commit?: string
	private file?: string
	private lineInFile = 0

	constructor(private readonly label: string) {}

	/** Returns the source label for this line. */
	advance(line: string): { source: string; line: number } {
		const commit = /^commit ([0-9a-f]{7,40})\b/.exec(line)
		if (commit) {
			this.commit = commit[1]?.slice(0, 10)
			this.file = undefined
			this.lineInFile = 0
		}
		const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
		if (file) {
			this.file = file[2]
			this.lineInFile = 0
		} else if (this.file) {
			this.lineInFile++
		}
		const parts = [this.label]
		if (this.commit) parts.push(this.commit)
		if (this.file) parts.push(this.file)
		return { source: parts.join(" "), line: this.file ? this.lineInFile : 0 }
	}
}

export function formatLeakHit(hit: LeakHit): string {
	const where = hit.line > 0 ? `${hit.source}:${hit.line}` : hit.source
	return `${where}: ${hit.needle.kind} "${truncate(hit.needle.text, 60)}"`
}

// ---------------------------------------------------------------------------
// Plan and matrix
// ---------------------------------------------------------------------------

export const RUN_LABELS = ["protocol-limit", "invalid"] as const
export type RunLabel = (typeof RUN_LABELS)[number]

export interface PlanCell {
	scenario: string
	/** Optional group, for example a model ("opus", "deepseek"). Arms are compared only within one group. */
	group?: string
	arm: string
	samples: number
	provider?: string
	modelId?: string
}

export interface PlanRun {
	taskId: string
	scenario: string
	/** Must match the `group` of its cell. Omitted when the plan has no groups. */
	group?: string
	arm: string
	/** Pair key for blind review, for example "r1". Runs of different arms with the same sample are paired. */
	sample?: string
	/** `protocol-limit`: stopped by the protocol's request limit, excluded from outcome scoring. `invalid`: excluded. */
	label?: RunLabel
	/** Path of the run's grades.json written by `grade`, relative to the plan file. */
	grades?: string
}

export interface Plan {
	build?: string
	cells: PlanCell[]
	runs: PlanRun[]
	/** Per scenario, the flattened settings keys that differ by arm (for example `experiments.cordisRuntimePreview`). */
	armSettings: Record<string, string[]>
	/** Phases of a multi-phase scenario (for example ["P1", "P2", "P3", "P4"]). When set, every run needs grades. */
	phases?: string[]
}

export interface ParsedPlan {
	plan: Plan
	errors: string[]
	duplicateTaskIds: string[]
}

/** Task IDs are folder names. Anything that could leave the tasks folder is refused (C-5). */
export const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * Parses plan.json. `runs` may be an object keyed by task ID or an array of `{ taskId, ... }`.
 * JSON.parse keeps only the last of duplicate object keys, so duplicates are found in the raw text.
 */
export function parsePlan(text: string): ParsedPlan {
	const errors: string[] = []
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		return {
			plan: { cells: [], runs: [], armSettings: {} },
			errors: [`plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
			duplicateTaskIds: [],
		}
	}
	const obj = isRecord(raw) ? raw : {}
	const build = typeof obj.build === "string" ? obj.build : undefined

	const cells: PlanCell[] = []
	if (!Array.isArray(obj.cells)) errors.push("plan.cells must be an array")
	for (const [index, value] of (Array.isArray(obj.cells) ? obj.cells : []).entries()) {
		if (!isRecord(value) || typeof value.scenario !== "string" || typeof value.arm !== "string") {
			errors.push(`plan.cells[${index}] needs string "scenario" and "arm"`)
			continue
		}
		const samples = typeof value.samples === "number" && value.samples > 0 ? Math.floor(value.samples) : 1
		if (value.group !== undefined && (typeof value.group !== "string" || value.group.length === 0)) {
			errors.push(`plan.cells[${index}]: "group" must be a non-empty string`)
			continue
		}
		cells.push({
			scenario: value.scenario,
			...(typeof value.group === "string" ? { group: value.group } : {}),
			arm: value.arm,
			samples,
			...(typeof value.provider === "string" ? { provider: value.provider } : {}),
			...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
		})
	}

	const entries: Array<[string, unknown]> = []
	if (Array.isArray(obj.runs)) {
		for (const value of obj.runs) {
			entries.push([isRecord(value) && typeof value.taskId === "string" ? value.taskId : "", value])
		}
	} else if (isRecord(obj.runs)) {
		entries.push(...Object.entries(obj.runs))
	} else {
		errors.push("plan.runs must be an object keyed by task ID or an array")
	}

	const counts = new Map<string, number>()
	const runs: PlanRun[] = []
	for (const [taskId, value] of entries) {
		counts.set(taskId, (counts.get(taskId) ?? 0) + 1)
		if (!SAFE_TASK_ID.test(taskId)) {
			errors.push(`run "${truncate(taskId, 40)}": task ID is not a plain folder name`)
			continue
		}
		if (!isRecord(value) || typeof value.scenario !== "string" || typeof value.arm !== "string") {
			errors.push(`run ${taskId}: needs string "scenario" and "arm"`)
			continue
		}
		if (value.group !== undefined && (typeof value.group !== "string" || value.group.length === 0)) {
			errors.push(`run ${taskId}: "group" must be a non-empty string`)
			continue
		}
		let label: RunLabel | undefined
		if (value.label !== undefined) {
			if (typeof value.label === "string" && (RUN_LABELS as readonly string[]).includes(value.label)) {
				label = value.label as RunLabel
			} else {
				errors.push(`run ${taskId}: label must be one of ${RUN_LABELS.join(", ")}`)
			}
		}
		if (value.grades !== undefined && (typeof value.grades !== "string" || value.grades.length === 0)) {
			errors.push(`run ${taskId}: "grades" must be a non-empty path string`)
		}
		runs.push({
			taskId,
			scenario: value.scenario,
			...(typeof value.group === "string" ? { group: value.group } : {}),
			arm: value.arm,
			...(typeof value.sample === "string" ? { sample: value.sample } : {}),
			...(label ? { label } : {}),
			...(typeof value.grades === "string" && value.grades.length > 0 ? { grades: value.grades } : {}),
		})
	}

	// Object form: count raw occurrences of each key inside "runs".
	if (!Array.isArray(obj.runs) && isRecord(obj.runs)) {
		for (const taskId of Object.keys(obj.runs)) {
			const occurrences = text.match(new RegExp(`"${escapeRegExp(taskId)}"\\s*:\\s*\\{`, "g"))?.length ?? 0
			if (occurrences > 1) counts.set(taskId, occurrences)
		}
	}
	const duplicateTaskIds = [...counts.entries()].filter(([id, n]) => id && n > 1).map(([id]) => id)

	const armSettings: Record<string, string[]> = {}
	if (isRecord(obj.armSettings)) {
		for (const [scenario, keys] of Object.entries(obj.armSettings)) {
			if (Array.isArray(keys)) armSettings[scenario] = keys.filter((k): k is string => typeof k === "string")
		}
	}

	let phases: string[] | undefined
	if (obj.phases !== undefined) {
		if (
			Array.isArray(obj.phases) &&
			obj.phases.length > 0 &&
			obj.phases.every((p) => typeof p === "string" && PHASE_PATTERN.test(p))
		) {
			phases = [...(obj.phases as string[])].sort((a, b) => phaseIndex(a) - phaseIndex(b))
		} else {
			errors.push('plan.phases must be a non-empty array of phase names such as "P1"')
		}
	}

	return {
		plan: { ...(build ? { build } : {}), cells, runs, armSettings, ...(phases ? { phases } : {}) },
		errors,
		duplicateTaskIds,
	}
}

/** The subset of evaluation.json that the matrix reads (shape from src/core/task/evaluation-recording.ts). */
export interface EvaluationManifest {
	version: number
	taskId: string
	parentTaskId?: string
	createdAt?: string
	extension?: { version?: string; commit?: string }
	provider?: string
	modelId?: string
	mode?: string
	profile?: string
	settingsDigest?: string
	settings?: Record<string, unknown>
	promptHash?: string
	stop?: { reason?: string; at?: string; apiRequests?: number }
}

export interface RunMetrics {
	requests: number
	tokensIn: number
	tokensOut: number
	cacheReads: number
	cacheWrites: number
	cost: number
}

/**
 * Totals from ui_messages.json, summed the same way as the task header (`consolidateTokenUsage` in
 * packages/core): every `say: "api_req_started"` row adds its tokens and cost, and condense and
 * truncation rows add their own cost. Requests is the number of `api_req_started` rows.
 */
export function summariseUiMessages(messages: unknown): RunMetrics {
	const metrics: RunMetrics = { requests: 0, tokensIn: 0, tokensOut: 0, cacheReads: 0, cacheWrites: 0, cost: 0 }
	if (!Array.isArray(messages)) return metrics
	for (const message of messages) {
		if (!isRecord(message) || message.type !== "say") continue
		if (message.say === "api_req_started") {
			metrics.requests++
			if (typeof message.text !== "string") continue
			let parsed: unknown
			try {
				parsed = JSON.parse(message.text)
			} catch {
				continue
			}
			if (!isRecord(parsed)) continue
			metrics.tokensIn += numberOr0(parsed.tokensIn)
			metrics.tokensOut += numberOr0(parsed.tokensOut)
			metrics.cacheReads += numberOr0(parsed.cacheReads)
			metrics.cacheWrites += numberOr0(parsed.cacheWrites)
			metrics.cost += numberOr0(parsed.cost)
		} else if (message.say === "condense_context" && isRecord(message.contextCondense)) {
			metrics.cost += numberOr0(message.contextCondense.cost)
		} else if (message.say === "sliding_window_truncation" && isRecord(message.contextTruncation)) {
			metrics.cost += numberOr0(message.contextTruncation.cost)
		}
	}
	return metrics
}

/** Flattens settings to dot paths, for example `experiments.cordisRuntimePreview`. */
export function flattenSettings(value: unknown, prefix = ""): Record<string, unknown> {
	const result: Record<string, unknown> = {}
	if (!isRecord(value)) return result
	for (const [key, child] of Object.entries(value)) {
		const pathKey = prefix ? `${prefix}.${key}` : key
		if (isRecord(child)) Object.assign(result, flattenSettings(child, pathKey))
		else if (child !== undefined) result[pathKey] = child
	}
	return result
}

/** Keys whose values differ between two flattened settings objects, minus the ignored keys. */
export function settingsDifferences(a: unknown, b: unknown, ignore: readonly string[] = []): string[] {
	const fa = flattenSettings(a)
	const fb = flattenSettings(b)
	const keys = new Set([...Object.keys(fa), ...Object.keys(fb)])
	return [...keys]
		.filter((key) => !ignore.includes(key) && JSON.stringify(fa[key]) !== JSON.stringify(fb[key]))
		.sort()
}

export interface RunInput {
	manifest?: EvaluationManifest
	manifestError?: string
	metrics?: RunMetrics
	metricsError?: string
	/** Number of entries in api_conversation_history.json. Counts only (Q-SEC-2). */
	historyMessages?: number
	/** Summary of the run's grades.json (multi-phase scenarios). */
	grades?: GradeSummary
	gradesError?: string
}

export type RunStatus = "valid" | "excluded" | "invalid"

export interface RunReport {
	run: PlanRun
	status: RunStatus
	problems: string[]
	notes: string[]
	input: RunInput
}

export interface CellReport {
	cell: PlanCell
	runs: RunReport[]
	/** Valid plus excluded (protocol-limit) runs. */
	present: number
	/** Valid runs only (scorable for outcome). */
	scorable: number
	problems: string[]
	ok: boolean
}

export interface ArmGradeMean {
	/** Valid runs with grades. */
	runs: number
	/** Mean hidden tests passed in the last graded phase (the cumulative suite). */
	finalPassed: number
	/** Mean number of hidden tests in the last graded phase. */
	finalTotal: number
	/** Mean number of regressed tests. */
	regressions: number
	/** Mean of finalPassed minus regressions (protocol rank metric). */
	score: number
	/** Runs whose own `npm test` passed in the last graded phase. */
	ownTestsPassing: number
}

export interface ArmMean {
	scenario: string
	group?: string
	arm: string
	runs: number
	mean: RunMetrics
	grades?: ArmGradeMean
}

export interface MatrixReport {
	runs: RunReport[]
	cells: CellReport[]
	planProblems: string[]
	means: ArmMean[]
	ok: boolean
}

const CELL_FIELDS: Array<[string, (m: EvaluationManifest) => string | undefined]> = [
	["extension.version", (m) => m.extension?.version],
	["settingsDigest", (m) => m.settingsDigest],
	["provider", (m) => m.provider],
	["modelId", (m) => m.modelId],
	["promptHash", (m) => m.promptHash],
]

const SCENARIO_FIELDS: Array<[string, (m: EvaluationManifest) => string | undefined]> = [
	["extension.version", (m) => m.extension?.version],
	["provider", (m) => m.provider],
	["modelId", (m) => m.modelId],
]

/** `scenario/arm`, or `scenario/group/arm` when a group is set. */
export function cellKey(scenario: string, arm: string, group?: string): string {
	return group === undefined ? `${scenario}/${arm}` : `${scenario}/${group}/${arm}`
}

/** `scenario`, or `scenario/group` when a group is set. Arms are compared within one such key. */
export function scenarioGroupKey(scenario: string, group?: string): string {
	return group === undefined ? scenario : `${scenario}/${group}`
}

/**
 * Checks the plan against the runs' manifests and metrics (Harness² `Ledger.assert_identity` plus
 * run-fingerprint matching).
 *
 * - Within a cell (scenario, optional group, and arm), every run must have the same extension version,
 *   settings digest, provider, model and prompt hash.
 * - Across the arms of a scenario within one group, version, provider and model must match, and settings
 *   may differ only in the keys listed in `plan.armSettings[scenario]`. The prompt hash may differ (for
 *   example `/plan`). Runs in different groups (for example different models) are not compared.
 * - A run needs a manifest and a stop reason `completed`. A run labelled `protocol-limit` with another
 *   stop reason is kept but excluded from outcome scoring and means.
 */
export function evaluateMatrix(
	plan: Plan,
	inputs: ReadonlyMap<string, RunInput>,
	duplicateTaskIds: string[] = [],
): MatrixReport {
	const planProblems = duplicateTaskIds.map((id) => `duplicate task ID in plan: ${id}`)
	const cellsByKey = new Map<string, CellReport>()
	for (const cell of plan.cells) {
		const key = cellKey(cell.scenario, cell.arm, cell.group)
		if (cellsByKey.has(key)) planProblems.push(`duplicate cell in plan: ${key}`)
		else cellsByKey.set(key, { cell, runs: [], present: 0, scorable: 0, problems: [], ok: true })
	}

	const runs: RunReport[] = []
	for (const run of plan.runs) {
		const input = inputs.get(run.taskId) ?? {}
		const report: RunReport = { run, status: "valid", problems: [], notes: [], input }
		const runCellKey = cellKey(run.scenario, run.arm, run.group)
		const cellReport = cellsByKey.get(runCellKey)
		if (!cellReport) report.problems.push(`no cell ${runCellKey} in plan`)
		if (duplicateTaskIds.includes(run.taskId)) report.problems.push("task ID listed more than once")
		if (run.label === "invalid") report.problems.push("labelled invalid in plan")

		const manifest = input.manifest
		if (!manifest) {
			report.problems.push(input.manifestError ?? "no evaluation.json")
		} else {
			if (manifest.taskId !== run.taskId) report.problems.push("manifest taskId does not match the folder")
			if (plan.build && manifest.extension?.version !== plan.build) {
				report.problems.push(`build ${manifest.extension?.version ?? "(none)"} is not ${plan.build}`)
			}
			if (cellReport?.cell.provider && manifest.provider !== cellReport.cell.provider) {
				report.problems.push(`provider ${manifest.provider ?? "(none)"} is not ${cellReport.cell.provider}`)
			}
			if (cellReport?.cell.modelId && manifest.modelId !== cellReport.cell.modelId) {
				report.problems.push(`model ${manifest.modelId ?? "(none)"} is not ${cellReport.cell.modelId}`)
			}
			if (!manifest.stop) {
				report.problems.push("no stop reason (task never ended, or ended before 4.2.95)")
			} else if (manifest.stop.reason !== "completed") {
				if (run.label === "protocol-limit") {
					report.notes.push(`stop ${manifest.stop.reason ?? "(none)"}, protocol-limit: excluded from outcome`)
				} else {
					report.problems.push(`stop reason ${manifest.stop.reason ?? "(none)"} is not completed`)
				}
			}
		}
		if (input.metricsError) report.problems.push(input.metricsError)
		if (input.gradesError) report.problems.push(input.gradesError)
		if (plan.phases) {
			if (!run.grades && !input.grades && !input.gradesError) {
				report.problems.push('plan has phases but the run has no "grades" path')
			} else if (input.grades && input.grades.missingPhases.length > 0) {
				report.notes.push(`not graded: ${input.grades.missingPhases.join(", ")}`)
			}
		}

		if (report.problems.length > 0) report.status = "invalid"
		else if (run.label === "protocol-limit") report.status = "excluded"
		runs.push(report)
		cellReport?.runs.push(report)
	}

	// Within-cell identity.
	for (const cellReport of cellsByKey.values()) {
		const key = cellKey(cellReport.cell.scenario, cellReport.cell.arm, cellReport.cell.group)
		const withManifest = cellReport.runs.filter((r) => r.input.manifest)
		const reference = withManifest[0]
		for (const other of withManifest.slice(1)) {
			for (const [field, get] of CELL_FIELDS) {
				const a = get(reference!.input.manifest!)
				const b = get(other.input.manifest!)
				if (a !== b) {
					cellReport.problems.push(
						`manifest mismatch in ${key}: ${field} ${a ?? "(none)"} (${short(reference!.run.taskId)}) vs ${b ?? "(none)"} (${short(other.run.taskId)})`,
					)
				}
			}
		}
		cellReport.present = cellReport.runs.filter((r) => r.status !== "invalid").length
		cellReport.scorable = cellReport.runs.filter((r) => r.status === "valid").length
		const invalid = cellReport.runs.filter((r) => r.status === "invalid").length
		if (invalid > 0) cellReport.problems.push(`${invalid} invalid run(s) in ${key}`)
		if (cellReport.present < cellReport.cell.samples) {
			cellReport.problems.push(
				`missing ${cellReport.cell.samples - cellReport.present} of ${cellReport.cell.samples} sample(s) in ${key}`,
			)
		}
	}

	// Across arms of a scenario, within one group.
	const scenarios = new Map<string, CellReport[]>()
	for (const cellReport of cellsByKey.values()) {
		const groupKey = scenarioGroupKey(cellReport.cell.scenario, cellReport.cell.group)
		const list = scenarios.get(groupKey) ?? []
		list.push(cellReport)
		scenarios.set(groupKey, list)
	}
	for (const [scenario, cellReports] of scenarios) {
		const reference = cellReports.flatMap((c) => c.runs).find((r) => r.input.manifest)
		if (!reference) continue
		const ignore = plan.armSettings[cellReports[0]!.cell.scenario] ?? []
		for (const cellReport of cellReports) {
			for (const other of cellReport.runs) {
				if (!other.input.manifest || other.run.arm === reference.run.arm) continue
				for (const [field, get] of SCENARIO_FIELDS) {
					const a = get(reference.input.manifest!)
					const b = get(other.input.manifest)
					if (a !== b) {
						cellReport.problems.push(
							`arm mismatch in ${scenario}: ${field} ${a ?? "(none)"} (${reference.run.arm}) vs ${b ?? "(none)"} (${other.run.arm}, ${short(other.run.taskId)})`,
						)
					}
				}
				const diff = settingsDifferences(
					reference.input.manifest!.settings,
					other.input.manifest.settings,
					ignore,
				)
				if (diff.length > 0) {
					cellReport.problems.push(
						`arm settings differ in ${scenario} beyond armSettings (${short(reference.run.taskId)} vs ${short(other.run.taskId)}): ${diff.join(", ")}`,
					)
				}
			}
		}
	}

	for (const cellReport of cellsByKey.values()) cellReport.ok = cellReport.problems.length === 0

	const means: ArmMean[] = []
	for (const cellReport of cellsByKey.values()) {
		const valid = cellReport.runs.filter((r) => r.status === "valid" && r.input.metrics)
		if (valid.length === 0) continue
		const sum = valid.reduce((acc, r) => addMetrics(acc, r.input.metrics!), emptyMetrics())
		const graded = valid.filter((r) => r.input.grades?.final)
		let grades: ArmGradeMean | undefined
		if (graded.length > 0) {
			const n = graded.length
			const total = (get: (g: GradeSummary) => number) => graded.reduce((acc, r) => acc + get(r.input.grades!), 0)
			grades = {
				runs: n,
				finalPassed: total((g) => g.final!.passed) / n,
				finalTotal: total((g) => g.final!.total) / n,
				regressions: total((g) => g.regressions) / n,
				score: total((g) => g.score) / n,
				ownTestsPassing: graded.filter((r) => r.input.grades!.ownTestsPass === true).length,
			}
		}
		means.push({
			scenario: cellReport.cell.scenario,
			...(cellReport.cell.group !== undefined ? { group: cellReport.cell.group } : {}),
			arm: cellReport.cell.arm,
			runs: valid.length,
			mean: divideMetrics(sum, valid.length),
			...(grades ? { grades } : {}),
		})
	}

	const cells = [...cellsByKey.values()]
	const ok = planProblems.length === 0 && cells.every((c) => c.ok) && runs.every((r) => r.status !== "invalid")
	return { runs, cells, planProblems, means, ok }
}

export function emptyMetrics(): RunMetrics {
	return { requests: 0, tokensIn: 0, tokensOut: 0, cacheReads: 0, cacheWrites: 0, cost: 0 }
}

function addMetrics(a: RunMetrics, b: RunMetrics): RunMetrics {
	return {
		requests: a.requests + b.requests,
		tokensIn: a.tokensIn + b.tokensIn,
		tokensOut: a.tokensOut + b.tokensOut,
		cacheReads: a.cacheReads + b.cacheReads,
		cacheWrites: a.cacheWrites + b.cacheWrites,
		cost: a.cost + b.cost,
	}
}

function divideMetrics(a: RunMetrics, n: number): RunMetrics {
	return {
		requests: a.requests / n,
		tokensIn: a.tokensIn / n,
		tokensOut: a.tokensOut / n,
		cacheReads: a.cacheReads / n,
		cacheWrites: a.cacheWrites / n,
		cost: a.cost / n,
	}
}

/** Fixed-width text table. */
export function formatTable(header: string[], rows: string[][]): string {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
	const line = (cells: string[]) =>
		cells
			.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd()
	return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n")
}

export function formatInt(value: number): string {
	return Math.round(value).toLocaleString("en-US")
}

export function formatCost(value: number): string {
	return `$${value.toFixed(2)}`
}

export function metricsCells(m: RunMetrics, requestsDecimals = 0): string[] {
	return [
		requestsDecimals ? m.requests.toFixed(requestsDecimals) : formatInt(m.requests),
		formatInt(m.tokensIn),
		formatInt(m.tokensOut),
		formatInt(m.cacheReads),
		formatInt(m.cacheWrites),
		formatCost(m.cost),
	]
}

// ---------------------------------------------------------------------------
// Blind review
// ---------------------------------------------------------------------------

export interface RunPair {
	sample: string
	runs: [PlanRun, PlanRun]
}

export interface PairingResult {
	arms: string[]
	pairs: RunPair[]
	unpaired: PlanRun[]
	problems: string[]
}

/**
 * Matched pairs for one scenario, within one group. Runs labelled `invalid` or `protocol-limit` are
 * left out (not scorable). Runs pair by `sample` when every run has one, otherwise by their order in the
 * plan. When `group` is given, only runs of that group are used. When it is not given and the scenario's
 * runs belong to more than one group (or mix grouped and ungrouped runs), nothing is paired, so runs on
 * different models are never compared.
 */
export function pairRuns(plan: Plan, scenario: string, group?: string, onlyArms?: string[]): PairingResult {
	const problems: string[] = []
	const label = scenarioGroupKey(scenario, group)
	const inScenario = plan.runs.filter(
		(r) => r.scenario === scenario && !r.label && (onlyArms === undefined || onlyArms.includes(r.arm)),
	)
	const candidates = group === undefined ? inScenario : inScenario.filter((r) => r.group === group)
	if (group === undefined) {
		const groups = [...new Set(inScenario.map((r) => r.group))]
		if (groups.length > 1) {
			const names = groups.map((g) => g ?? "(none)").join(", ")
			problems.push(`scenario ${scenario} has runs in more than one group (${names}); choose one group`)
			return { arms: [...new Set(candidates.map((r) => r.arm))], pairs: [], unpaired: candidates, problems }
		}
	}
	const arms = [...new Set(candidates.map((r) => r.arm))]
	if (arms.length !== 2) {
		problems.push(`scenario ${label} needs exactly 2 arms with scorable runs, found ${arms.length}`)
		return { arms, pairs: [], unpaired: candidates, problems }
	}
	const [armA, armB] = arms as [string, string]
	const left = candidates.filter((r) => r.arm === armA)
	const right = candidates.filter((r) => r.arm === armB)
	const pairs: RunPair[] = []
	const unpaired: PlanRun[] = []
	if (candidates.every((r) => r.sample)) {
		const used = new Set<string>()
		for (const l of left) {
			const r = right.find((x) => x.sample === l.sample && !used.has(x.taskId))
			if (r) {
				used.add(r.taskId)
				pairs.push({ sample: l.sample!, runs: [l, r] })
			} else {
				unpaired.push(l)
			}
		}
		unpaired.push(...right.filter((r) => !used.has(r.taskId)))
	} else {
		const n = Math.min(left.length, right.length)
		for (let i = 0; i < n; i++) pairs.push({ sample: `#${i + 1}`, runs: [left[i]!, right[i]!] })
		unpaired.push(...left.slice(n), ...right.slice(n))
	}
	return { arms, pairs, unpaired, problems }
}

export interface BlindKeyEntry {
	sample: string
	A: { taskId: string; arm: string }
	B: { taskId: string; arm: string }
}

export interface BlindKey {
	version: 1
	scenario: string
	group?: string
	createdAt: string
	pairs: Record<string, BlindKeyEntry>
}

export interface BlindAssignment {
	pairId: string
	/** Run shown as candidate A, then B. */
	A: PlanRun
	B: PlanRun
	sample: string
}

/** Random source: returns a float in [0, 1) and random hex IDs. Injected for tests. */
export interface BlindRandom {
	next(): number
	id(): string
}

/**
 * Assigns each pair a random ID and a random A/B order, and shuffles the pair order. The arm names
 * appear only in the returned key, never in a pair ID.
 */
export function assignBlind(
	scenario: string,
	pairs: RunPair[],
	random: BlindRandom,
	now = new Date(),
	group?: string,
): { assignments: BlindAssignment[]; key: BlindKey } {
	const assignments: BlindAssignment[] = []
	const used = new Set<string>()
	for (const pair of pairs) {
		let pairId = `pair-${random.id()}`
		while (used.has(pairId)) pairId = `pair-${random.id()}`
		used.add(pairId)
		const swap = random.next() < 0.5
		const [first, second] = pair.runs
		assignments.push({ pairId, A: swap ? second : first, B: swap ? first : second, sample: pair.sample })
	}
	// Fisher-Yates, so the output order does not follow the plan order.
	for (let i = assignments.length - 1; i > 0; i--) {
		const j = Math.floor(random.next() * (i + 1))
		;[assignments[i], assignments[j]] = [assignments[j]!, assignments[i]!]
	}
	const key: BlindKey = {
		version: 1,
		scenario,
		...(group !== undefined ? { group } : {}),
		createdAt: now.toISOString(),
		pairs: {},
	}
	for (const a of assignments) {
		key.pairs[a.pairId] = {
			sample: a.sample,
			A: { taskId: a.A.taskId, arm: a.A.arm },
			B: { taskId: a.B.taskId, arm: a.B.arm },
		}
	}
	return { assignments, key }
}

export const JUDGE_CHOICES = ["A", "B"] as const
export type JudgeChoice = (typeof JUDGE_CHOICES)[number]

/**
 * Judge prompt for one pair. Contains the task prompt, the follow-up messages (if any) and candidate file
 * names only, no arm names. Follow-ups are listed in the order they were sent, without their file names.
 */
export function buildJudgePrompt(pairId: string, taskPrompt: string, followups: string[] = []): string {
	const quote = (text: string) =>
		text
			.trimEnd()
			.split(/\r?\n/)
			.map((line) => (line ? `> ${line}` : ">"))
	const followupLines =
		followups.length === 0
			? []
			: [
					"## Messages the user sent during the task",
					"",
					"Both candidates received these messages, in this order, after the task above. Each message was sent only after the candidate reported the previous step as complete, except where a message arrived while a step was in progress.",
					"",
					...followups.flatMap((text, index) => [`### Message ${index + 1}`, "", ...quote(text), ""]),
				]
	return [
		`# Blind review ${pairId}`,
		"",
		"Two candidate changes, A and B, were made for the same task, starting from the same commit of the same repository. Each candidate is a `git diff` against that commit.",
		"",
		"## Task given to both candidates",
		"",
		...quote(taskPrompt),
		"",
		...followupLines,
		"## Candidates",
		"",
		"- Candidate A: `A.diff` in this folder",
		"- Candidate B: `B.diff` in this folder",
		"",
		"## Instructions",
		"",
		"1. Read both diffs in full.",
		"2. Judge which candidate completes the task better: correctness, completeness against the task, tests, compatibility with stored data, and code quality.",
		"3. Do not try to find out how the candidates were produced. Do not read any other file in this folder's parent.",
		"4. Choose exactly one candidate. There is no tie option.",
		"",
		"## Answer format",
		"",
		"Reply with exactly one fenced block with the info string `choice`, containing only `A` or `B`, followed by your written reason:",
		"",
		"```choice",
		"A",
		"```",
		"",
		"Reason: <two to six sentences that name the concrete differences that decided the choice>",
		"",
	].join("\n")
}

/**
 * Reads the choice from a judge reply. Accepts the bare value `A` or `B`, or text that contains exactly
 * one fenced `choice` block. Returns undefined for anything else.
 */
export function parseJudgeChoice(text: string): JudgeChoice | undefined {
	const bare = text.trim()
	if ((JUDGE_CHOICES as readonly string[]).includes(bare)) return bare as JudgeChoice
	const blocks = [...text.matchAll(/```choice[^\n]*\n([\s\S]*?)```/g)]
	if (blocks.length !== 1) return undefined
	const value = (blocks[0]?.[1] ?? "").trim()
	return (JUDGE_CHOICES as readonly string[]).includes(value) ? (value as JudgeChoice) : undefined
}

export interface BlindScore {
	wins: Record<string, number>
	answered: number
	missing: string[]
	invalid: string[]
	unknown: string[]
	perPair: Array<{ pairId: string; sample: string; winnerArm: string; winnerTaskId: string }>
}

/**
 * Joins answers to the key. An answer is either a string (`"A"`, `"B"`, or the judge's full reply) or
 * an object with `choice` (same forms) and an optional `reason`.
 */
export function scoreBlind(key: BlindKey, answers: Record<string, unknown>): BlindScore {
	const wins: Record<string, number> = {}
	for (const entry of Object.values(key.pairs)) {
		wins[entry.A.arm] ??= 0
		wins[entry.B.arm] ??= 0
	}
	const score: BlindScore = { wins, answered: 0, missing: [], invalid: [], unknown: [], perPair: [] }
	for (const pairId of Object.keys(answers)) if (!key.pairs[pairId]) score.unknown.push(pairId)
	for (const [pairId, entry] of Object.entries(key.pairs)) {
		const answer = answers[pairId]
		if (answer === undefined) {
			score.missing.push(pairId)
			continue
		}
		const text =
			typeof answer === "string"
				? answer
				: isRecord(answer) && typeof answer.choice === "string"
					? answer.choice
					: ""
		const choice = parseJudgeChoice(text)
		if (!choice) {
			score.invalid.push(pairId)
			continue
		}
		const winner = entry[choice]
		wins[winner.arm] = (wins[winner.arm] ?? 0) + 1
		score.answered++
		score.perPair.push({ pairId, sample: entry.sample, winnerArm: winner.arm, winnerTaskId: winner.taskId })
	}
	return score
}

/**
 * Counts added diff lines that mention an arm name as a whole word (case-insensitive). A word boundary
 * is any character that is not a letter or a digit, so `customModes` does not mention `modes`, while
 * `"modes"` and `cordis-preview` (for `cordis`) do. Content is not changed.
 */
export function countArmMentions(diff: string, arms: string[]): Record<string, number> {
	const counts: Record<string, number> = {}
	const patterns = arms.map(
		(arm) => [arm, new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(arm)}(?![\\p{L}\\p{N}])`, "iu")] as const,
	)
	for (const arm of arms) counts[arm] = 0
	for (const line of diff.split(/\r?\n/)) {
		if (!line.startsWith("+") || line.startsWith("+++")) continue
		for (const [arm, pattern] of patterns) if (pattern.test(line)) counts[arm] = (counts[arm] ?? 0) + 1
	}
	return counts
}

// ---------------------------------------------------------------------------
// Phase grading (multi-phase scenarios such as L1)
// ---------------------------------------------------------------------------

export const PHASE_PATTERN = /^P([1-9]\d*)$/

/** 1 for "P1". NaN for anything that is not a phase name. */
export function phaseIndex(phase: string): number {
	const match = PHASE_PATTERN.exec(phase)
	return match ? Number(match[1]) : Number.NaN
}

export type AmountMode = "decimal" | "cents"

export interface FileResult {
	passed: number
	failed: number
}

export interface GradeEntry {
	phase: string
	amountMode: AmountMode
	gradedAt: string
	testsPassed: number
	testsFailed: number
	perFile: Record<string, FileResult>
	ownTestsPass: boolean
	/** Test IDs that passed in an earlier phase of the same grades file and fail now. */
	regressions: string[]
	/** Test ID (`<file> > <test name>`) to outcome. Skipped tests are left out. */
	results: Record<string, "pass" | "fail">
	serverStarted: boolean
	/** Files in the workspace that changed while grading (git status), excluding node_modules. */
	workspaceChanges?: string[]
	notes?: string[]
}

export interface GradesFile {
	version: 1
	entries: GradeEntry[]
}

/** Parses grades.json. A missing or empty text gives an empty file. */
export function parseGrades(text: string | undefined): { grades: GradesFile; errors: string[] } {
	const empty: GradesFile = { version: 1, entries: [] }
	if (text === undefined || text.trim() === "") return { grades: empty, errors: [] }
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		return {
			grades: empty,
			errors: [`grades file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
		}
	}
	if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
		return { grades: empty, errors: ["grades file is not a version 1 grades file"] }
	}
	const errors: string[] = []
	const entries: GradeEntry[] = []
	for (const [index, value] of raw.entries.entries()) {
		if (
			!isRecord(value) ||
			typeof value.phase !== "string" ||
			!PHASE_PATTERN.test(value.phase) ||
			typeof value.testsPassed !== "number" ||
			typeof value.testsFailed !== "number" ||
			!isRecord(value.results)
		) {
			errors.push(`grades.entries[${index}] needs "phase", "testsPassed", "testsFailed" and "results"`)
			continue
		}
		const results: Record<string, "pass" | "fail"> = {}
		for (const [id, outcome] of Object.entries(value.results)) {
			if (outcome === "pass" || outcome === "fail") results[id] = outcome
		}
		const perFile: Record<string, FileResult> = {}
		if (isRecord(value.perFile)) {
			for (const [file, r] of Object.entries(value.perFile)) {
				if (isRecord(r)) perFile[file] = { passed: numberOr0(r.passed), failed: numberOr0(r.failed) }
			}
		}
		entries.push({
			phase: value.phase,
			amountMode: value.amountMode === "cents" ? "cents" : "decimal",
			gradedAt: typeof value.gradedAt === "string" ? value.gradedAt : "",
			testsPassed: value.testsPassed,
			testsFailed: value.testsFailed,
			perFile,
			ownTestsPass: value.ownTestsPass === true,
			regressions: Array.isArray(value.regressions)
				? value.regressions.filter((r): r is string => typeof r === "string")
				: [],
			results,
			serverStarted: value.serverStarted !== false,
			...(Array.isArray(value.workspaceChanges)
				? { workspaceChanges: value.workspaceChanges.filter((r): r is string => typeof r === "string") }
				: {}),
			...(Array.isArray(value.notes)
				? { notes: value.notes.filter((r): r is string => typeof r === "string") }
				: {}),
		})
	}
	entries.sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase))
	return { grades: { version: 1, entries }, errors }
}

/**
 * Tests that passed in any recorded phase before `phase` and do not pass now. A test that did not run
 * now counts as not passing. Sorted.
 */
export function computeRegressions(
	previous: readonly GradeEntry[],
	phase: string,
	results: Readonly<Record<string, "pass" | "fail">>,
): string[] {
	const current = phaseIndex(phase)
	const passedBefore = new Set<string>()
	for (const entry of previous) {
		if (!(phaseIndex(entry.phase) < current)) continue
		for (const [id, outcome] of Object.entries(entry.results)) if (outcome === "pass") passedBefore.add(id)
	}
	return [...passedBefore].filter((id) => results[id] !== "pass").sort()
}

/** Adds or replaces the entry for its phase; entries stay sorted by phase. */
export function upsertGradeEntry(grades: GradesFile, entry: GradeEntry): GradesFile {
	const entries = grades.entries.filter((e) => e.phase !== entry.phase)
	entries.push(entry)
	entries.sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase))
	return { version: 1, entries }
}

export interface GradeSummary {
	perPhase: Array<{ phase: string; passed: number; total: number; regressions: number; ownTestsPass: boolean }>
	/** The last graded phase. Its suite includes every earlier phase's tests. */
	final?: { phase: string; passed: number; total: number }
	/** Distinct test IDs that regressed in any phase (a regression fixed later still counts). */
	regressions: number
	/** final.passed minus regressions: the protocol's rank metric. */
	score: number
	/** Own `npm test` result of the last graded phase. */
	ownTestsPass?: boolean
	/** Planned phases without an entry. */
	missingPhases: string[]
}

export function summariseGrades(grades: GradesFile, phases: readonly string[] = []): GradeSummary {
	const perPhase = grades.entries.map((e) => ({
		phase: e.phase,
		passed: e.testsPassed,
		total: e.testsPassed + e.testsFailed,
		regressions: e.regressions.length,
		ownTestsPass: e.ownTestsPass,
	}))
	const last = grades.entries[grades.entries.length - 1]
	const regressed = new Set(grades.entries.flatMap((e) => e.regressions))
	const final = last
		? { phase: last.phase, passed: last.testsPassed, total: last.testsPassed + last.testsFailed }
		: undefined
	return {
		perPhase,
		...(final ? { final } : {}),
		regressions: regressed.size,
		score: (final?.passed ?? 0) - regressed.size,
		...(last ? { ownTestsPass: last.ownTestsPass } : {}),
		missingPhases: phases.filter((p) => !grades.entries.some((e) => e.phase === p)),
	}
}

export interface TapTest {
	name: string
	ok: boolean
	skipped: boolean
}

/**
 * Top-level test results from TAP written by `node --test --test-reporter=tap <file>`. Handles both
 * layouts: tests at the top level (Node 22 and later), and tests nested under one top-level entry named
 * after the file (Node 20). Subtests deeper than that are ignored. `# SKIP` and `# TODO` are skipped.
 */
export function parseTap(text: string, fileName?: string): TapTest[] {
	const pattern = /^( *)(not ok|ok) \d+(?: - (.*?))?(?: # (SKIP|TODO)\b.*)?$/i
	const byIndent = new Map<number, TapTest[]>()
	for (const line of text.split(/\r?\n/)) {
		const match = pattern.exec(line)
		if (!match) continue
		const indent = match[1]!.length
		const name = (match[3] ?? "").replace(/\\#/g, "#").replace(/\\\\/g, "\\")
		const list = byIndent.get(indent) ?? []
		list.push({ name, ok: match[2]!.toLowerCase() === "ok", skipped: match[4] !== undefined })
		byIndent.set(indent, list)
	}
	const top = byIndent.get(0) ?? []
	const isFileEntry = (t: TapTest) =>
		fileName !== undefined &&
		(t.name === fileName || t.name.endsWith(`/${fileName}`) || t.name.endsWith(`\\${fileName}`))
	if (top.length === 1 && isFileEntry(top[0]!)) {
		const nested = byIndent.get(4)
		if (nested && nested.length > 0) return nested
	}
	return top
}

/** Results keyed by test ID `<file> > <name>`, with per-file counts. Duplicate names get a ` #2` suffix. */
export function collectResults(files: Array<{ file: string; tests: TapTest[] }>): {
	results: Record<string, "pass" | "fail">
	perFile: Record<string, FileResult>
	passed: number
	failed: number
} {
	const results: Record<string, "pass" | "fail"> = {}
	const perFile: Record<string, FileResult> = {}
	let passed = 0
	let failed = 0
	for (const { file, tests } of files) {
		const counts: FileResult = { passed: 0, failed: 0 }
		for (const test of tests) {
			if (test.skipped) continue
			let id = `${file} > ${test.name}`
			for (let n = 2; id in results; n++) id = `${file} > ${test.name} #${n}`
			results[id] = test.ok ? "pass" : "fail"
			if (test.ok) counts.passed++
			else counts.failed++
		}
		perFile[file] = counts
		passed += counts.passed
		failed += counts.failed
	}
	return { results, perFile, passed, failed }
}

/** Hidden test files for a phase and every earlier phase, in phase order (`P1.test.mjs` and so on). */
export function selectPhaseTestFiles(fileNames: readonly string[], phase: string): string[] {
	const limit = phaseIndex(phase)
	return fileNames
		.map((name) => ({ name, match: /^P([1-9]\d*)\.test\.mjs$/.exec(name) }))
		.filter((f) => f.match && Number(f.match[1]) <= limit)
		.sort((a, b) => Number(a.match![1]) - Number(b.match![1]))
		.map((f) => f.name)
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function short(taskId: string): string {
	return taskId.slice(0, 8)
}
