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
	kind: "protocol-file-name" | "scripted-string" | "extra-string"
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
}

export interface Plan {
	build?: string
	cells: PlanCell[]
	runs: PlanRun[]
	/** Per scenario, the flattened settings keys that differ by arm (for example `experiments.cordisRuntimePreview`). */
	armSettings: Record<string, string[]>
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
		runs.push({
			taskId,
			scenario: value.scenario,
			...(typeof value.group === "string" ? { group: value.group } : {}),
			arm: value.arm,
			...(typeof value.sample === "string" ? { sample: value.sample } : {}),
			...(label ? { label } : {}),
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

	return { plan: { ...(build ? { build } : {}), cells, runs, armSettings }, errors, duplicateTaskIds }
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

export interface ArmMean {
	scenario: string
	group?: string
	arm: string
	runs: number
	mean: RunMetrics
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
		means.push({
			scenario: cellReport.cell.scenario,
			...(cellReport.cell.group !== undefined ? { group: cellReport.cell.group } : {}),
			arm: cellReport.cell.arm,
			runs: valid.length,
			mean: divideMetrics(sum, valid.length),
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
export function pairRuns(plan: Plan, scenario: string, group?: string): PairingResult {
	const problems: string[] = []
	const label = scenarioGroupKey(scenario, group)
	const inScenario = plan.runs.filter((r) => r.scenario === scenario && !r.label)
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

/** Judge prompt for one pair. Contains the task prompt and candidate file names only, no arm names. */
export function buildJudgePrompt(pairId: string, taskPrompt: string): string {
	return [
		`# Blind review ${pairId}`,
		"",
		"Two candidate changes, A and B, were made for the same task, starting from the same commit of the same repository. Each candidate is a `git diff` against that commit.",
		"",
		"## Task given to both candidates",
		"",
		...taskPrompt.split(/\r?\n/).map((line) => `> ${line}`),
		"",
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
