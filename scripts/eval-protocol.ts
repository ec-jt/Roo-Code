/**
 * Evaluation protocol tooling (developer only, not shipped in the VSIX).
 * ADR-2026-11-20-feature-gating-evaluation-and-lessons, R-6. Usage: docs/eval-protocol-tooling.md.
 *
 *   pnpm eval:protocol leak-check   --workspace <dir> --protocol <file> [--extra <strings-file>] [--forbid <dir>]...
 *   pnpm eval:protocol matrix       --plan <plan.json> --tasks-dir <globalStorage>/tasks
 *   pnpm eval:protocol blind-export --plan <plan.json> --scenario S2 [--group <g>] --workspaces <map.json> --out <dir>
 *   pnpm eval:protocol blind-score  --out <dir> --answers <answers.json>
 *   pnpm eval:protocol grade        --workspace <dir> --phase P1 --tests <hidden-tests> --out <grades.json>
 *
 * Constraints: reads only the task folders named in the plan and never writes task storage (C-5);
 * prints counts only from api_conversation_history.json and no environment values (Q-SEC-2);
 * calls no model API and reads no API key. `grade` runs the workspace's own npm scripts, so use it
 * only on workspaces you would run anyway.
 */
import { type ChildProcess, spawn } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import * as readline from "readline"

import { safeWriteJson } from "../src/utils/safeWriteJson"

import {
	type AmountMode,
	type BlindKey,
	type GradeEntry,
	type LeakHit,
	type Needle,
	type RunInput,
	type TapTest,
	LEAK_SKIP_DIRECTORIES,
	PHASE_PATTERN,
	PatchCursor,
	SAFE_TASK_ID,
	assignBlind,
	buildJudgePrompt,
	buildNeedles,
	collectResults,
	computeRegressions,
	countArmMentions,
	distinctiveLines,
	evaluateMatrix,
	extractScenarioPrompt,
	extractScriptedStrings,
	formatLeakHit,
	formatTable,
	isRecord,
	looksBinary,
	matchLine,
	metricsCells,
	pairRuns,
	parseExtraStrings,
	parseGrades,
	parsePlan,
	parseTap,
	phaseIndex,
	scanForbiddenName,
	scanPath,
	scanText,
	scoreBlind,
	selectPhaseTestFiles,
	summariseGrades,
	summariseUiMessages,
	upsertGradeEntry,
} from "./eval-protocol/lib"

const DEFAULT_PROTOCOL = "docs/architecture/evaluation-2026-11-18.md"

const USAGE = `Usage: pnpm eval:protocol <command> [options]

Commands:
  leak-check    --workspace <dir> --protocol <file> [--extra <strings-file>] [--forbid <dir>]...
                [--max-file-bytes <n>] [--max-commits <n>] [--max-print <n>]
      Fails (exit 1) if the workspace contains the protocol file name or a scripted
      string (section 4 blockquotes and italic quotes, plus extra lines) in any file,
      in "git diff HEAD", or in "git log -p --all". Skips node_modules and .git.
      --forbid (repeatable) also fails on any distinctive line of any file under that
      folder, and on a file whose name matches a file in it.

  matrix        --plan <plan.json> --tasks-dir <globalStorage>/tasks
      Checks the planned cells against each run's evaluation.json and prints
      requests, tokens, cache and cost per run and the mean per arm. Reads only
      the task folders listed in plan.runs. Exit 1 if any cell is invalid.
      Cells and runs may set "group" (for example a model); arms are then
      compared, and means reported, per scenario and group. Runs may set
      "grades" (a grades.json from "grade"); the plan may set "phases".

  blind-export  --plan <plan.json> --scenario <id> [--group <g>] [--arms <a,b>] --workspaces <map.json>
                --out <dir> [--protocol <file> | --prompt-file <file>] [--followups <file>]...
      Writes one anonymised folder per matched pair under <out>/judge/ (A.diff,
      B.diff, judge-prompt.md), and <out>/key.json outside it. Calls no model.
      Pairs only runs of one group; --group is required when the scenario's
      runs are in more than one group. --arms picks two arms when there are more.
      --followups (repeatable, in the order sent) lists later user messages.

  blind-score   --out <dir> --answers <answers.json>
      Joins the judge's choices to the arms with <out>/key.json and prints wins.

  grade         --workspace <dir> --phase <P1..Pn> --tests <hidden-tests-dir> --out <grades.json>
                [--amount-mode decimal|cents] [--start-timeout <s>] [--test-timeout <s>]
                [--own-test-timeout <s>]
      Copies the hidden tests of this and earlier phases to a temporary folder, starts
      "npm start" in the workspace on a free PORT, runs the tests with BASE_URL, runs
      the workspace's "npm test", stops the server, and adds the phase to grades.json
      with regressions against earlier phases. Exit 1 if a test fails.

Default --protocol: ${DEFAULT_PROTOCOL}`

type Args = Record<string, string>

/** Separator for repeated option values inside one Args entry. */
const MULTI_SEPARATOR = "\u0000"

function parseArgs(argv: string[], allowed: string[], repeatable: string[] = []): Args {
	const args: Args = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		if (arg === "--") continue
		if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`)
		const name = arg.slice(2)
		if (!allowed.includes(name) && !repeatable.includes(name)) throw new UsageError(`Unknown option: ${arg}`)
		const value = argv[i + 1]
		if (value === undefined || value.startsWith("--")) throw new UsageError(`Option ${arg} needs a value`)
		if (repeatable.includes(name) && args[name] !== undefined) args[name] += MULTI_SEPARATOR + value
		else if (args[name] !== undefined) throw new UsageError(`Option ${arg} given more than once`)
		else args[name] = value
		i++
	}
	return args
}

/** All values of a repeatable option, in the order given. */
function many(args: Args, name: string): string[] {
	const value = args[name]
	return value === undefined ? [] : value.split(MULTI_SEPARATOR)
}

function required(args: Args, name: string): string {
	const value = args[name]
	if (!value) throw new UsageError(`Missing --${name}`)
	return value
}

function optionalInt(args: Args, name: string, fallback: number): number {
	const value = args[name]
	if (value === undefined) return fallback
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`--${name} must be a non-negative integer`)
	return parsed
}

class UsageError extends Error {}

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await fs.readFile(filePath, "utf8"))
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

/** Runs git and streams stdout line by line. The child gets the parent environment unchanged unless `env` is given. */
function gitLines(
	cwd: string,
	args: string[],
	onLine: (line: string) => boolean | void,
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; stderr: string; stopped: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=off", ...args], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stderr = ""
		let stopped = false
		child.stderr.on("data", (chunk) => {
			if (stderr.length < 4000) stderr += String(chunk)
		})
		const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
		rl.on("line", (line) => {
			if (stopped) return
			if (onLine(line) === false) {
				stopped = true
				rl.close()
				child.kill()
			}
		})
		child.on("error", reject)
		child.on("close", (code) => resolve({ code: code ?? (stopped ? 0 : 1), stderr: stderr.trim(), stopped }))
	})
}

async function gitText(
	cwd: string,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number; text: string; stderr: string }> {
	const lines: string[] = []
	const result = await gitLines(cwd, args, (line) => void lines.push(line), env)
	return { code: result.code, text: lines.join("\n"), stderr: result.stderr }
}

// ---------------------------------------------------------------------------
// leak-check
// ---------------------------------------------------------------------------

/** Every regular file under a folder (no symlinks followed), skipping node_modules and .git. */
async function listFilesRecursive(root: string): Promise<string[]> {
	const result: string[] = []
	const walk = async (dir: string) => {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		entries.sort((a, b) => (a.name < b.name ? -1 : 1))
		for (const entry of entries) {
			if (LEAK_SKIP_DIRECTORIES.has(entry.name)) continue
			const full = path.join(dir, entry.name)
			if (entry.isDirectory()) await walk(full)
			else if (entry.isFile()) result.push(full)
		}
	}
	await walk(root)
	return result
}

/** Distinctive lines and file names of the --forbid folders. */
async function loadForbidden(dirs: string[], workspace: string): Promise<{ lines: string[]; names: Set<string> }> {
	const lines: string[] = []
	const names = new Set<string>()
	for (const dir of dirs) {
		const root = path.resolve(dir)
		const rel = path.relative(root, workspace)
		if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
			throw new UsageError(`--forbid ${dir} contains the workspace; choose a folder outside it`)
		}
		for (const file of await listFilesRecursive(root)) {
			names.add(path.basename(file))
			const buffer = await fs.readFile(file)
			if (!looksBinary(buffer)) lines.push(...distinctiveLines(buffer.toString("utf8")))
		}
	}
	return { lines: [...new Set(lines)], names }
}

async function leakCheck(argv: string[]): Promise<number> {
	const args = parseArgs(
		argv,
		["workspace", "protocol", "extra", "max-file-bytes", "max-commits", "max-print"],
		["forbid"],
	)
	const workspace = path.resolve(required(args, "workspace"))
	const protocolPath = path.resolve(required(args, "protocol"))
	const maxFileBytes = optionalInt(args, "max-file-bytes", 5 * 1024 * 1024)
	const maxCommits = optionalInt(args, "max-commits", 0)
	const maxPrint = optionalInt(args, "max-print", 200)

	const protocolText = await fs.readFile(protocolPath, "utf8")
	const scripted = extractScriptedStrings(protocolText)
	const extra = args.extra ? parseExtraStrings(await fs.readFile(path.resolve(args.extra), "utf8")) : []
	const needles = buildNeedles(path.basename(protocolPath), scripted, extra)
	const forbidDirs = many(args, "forbid")
	const forbidden = await loadForbidden(forbidDirs, workspace)
	const known = new Set(needles.map((n) => n.text))
	for (const line of forbidden.lines) {
		if (!known.has(line)) needles.push({ kind: "forbidden-line", text: line })
	}
	console.log(
		`Leak check of ${workspace}: protocol file name, ${scripted.length} scripted strings, ${extra.length} extra strings` +
			(forbidDirs.length > 0
				? `, ${forbidden.lines.length} forbidden lines and ${forbidden.names.size} forbidden file names from ${forbidDirs.length} folder(s).`
				: "."),
	)

	const hits: LeakHit[] = []
	const add = (found: LeakHit[]) => {
		for (const hit of found) {
			if (hits.length < maxPrint) console.log(`  ${formatLeakHit(hit)}`)
			hits.push(hit)
		}
	}

	// 1. Files on disk (tracked, untracked and ignored), without following symlinks.
	const fileStats = { scanned: 0, binary: 0, large: 0, unreadable: 0 }
	const walk = async (dir: string): Promise<void> => {
		let entries: import("fs").Dirent[]
		try {
			entries = await fs.readdir(dir, { withFileTypes: true })
		} catch {
			fileStats.unreadable++
			return
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : 1))
		for (const entry of entries) {
			if (LEAK_SKIP_DIRECTORIES.has(entry.name)) continue
			const full = path.join(dir, entry.name)
			const relative = path.relative(workspace, full).split(path.sep).join("/")
			add(scanPath(relative, needles))
			if (entry.isFile()) add(scanForbiddenName(relative, forbidden.names))
			if (entry.isDirectory()) {
				await walk(full)
			} else if (entry.isFile()) {
				let buffer: Buffer
				try {
					const stat = await fs.stat(full)
					if (stat.size > maxFileBytes) {
						fileStats.large++
						continue
					}
					buffer = await fs.readFile(full)
				} catch {
					fileStats.unreadable++
					continue
				}
				if (looksBinary(buffer)) {
					fileStats.binary++
					continue
				}
				fileStats.scanned++
				add(scanText(relative, buffer.toString("utf8"), needles))
			}
		}
	}
	await walk(workspace)
	console.log(
		`Files: ${fileStats.scanned} scanned, ${fileStats.binary} binary skipped, ${fileStats.large} over ${maxFileBytes} bytes skipped, ${fileStats.unreadable} unreadable.`,
	)

	// 2. git diff and git log -p (only if the workspace is a git work tree).
	const inside = await gitText(workspace, ["rev-parse", "--is-inside-work-tree"]).catch(() => undefined)
	if (inside?.code === 0 && inside.text.trim() === "true") {
		const scanGit = async (label: string, gitArgs: string[]) => {
			const cursor = new PatchCursor(label)
			let lines = 0
			const before = hits.length
			const result = await gitLines(workspace, gitArgs, (line) => {
				lines++
				const where = cursor.advance(line)
				for (const needle of matchLine(line, needles)) add([{ source: where.source, line: where.line, needle }])
			})
			const note = result.code === 0 ? "" : ` (git exit ${result.code}: ${result.stderr.split("\n")[0] ?? ""})`
			console.log(`${label}: ${lines} lines, ${hits.length - before} hits${note}.`)
		}
		await scanGit("git diff HEAD", ["diff", "HEAD", "--no-color", "--no-ext-diff"])
		const logArgs = ["log", "-p", "--all", "--no-color", "--no-ext-diff"]
		if (maxCommits > 0) logArgs.push(`--max-count=${maxCommits}`)
		await scanGit(maxCommits > 0 ? `git log -p (last ${maxCommits})` : "git log -p", logArgs)
	} else {
		console.log("Not a git work tree: git diff and git log were not checked.")
	}

	if (hits.length > maxPrint) console.log(`  ... ${hits.length - maxPrint} more hits not printed (--max-print).`)
	const byKind = new Map<Needle["kind"], number>()
	for (const hit of hits) byKind.set(hit.needle.kind, (byKind.get(hit.needle.kind) ?? 0) + 1)
	const summary = [...byKind.entries()].map(([kind, n]) => `${kind} ${n}`).join(", ")
	console.log(hits.length === 0 ? "No leaks found." : `LEAK: ${hits.length} hits (${summary}).`)
	return hits.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// matrix
// ---------------------------------------------------------------------------

/** The folder of one task, refusing anything that is not a direct child of the tasks folder (C-5). */
function taskFolder(tasksDir: string, taskId: string): string {
	if (!SAFE_TASK_ID.test(taskId)) throw new Error(`unsafe task ID: ${taskId}`)
	const folder = path.join(tasksDir, taskId)
	if (path.dirname(folder) !== tasksDir) throw new Error(`task ID escapes the tasks folder: ${taskId}`)
	return folder
}

async function readRunInput(tasksDir: string, taskId: string): Promise<RunInput> {
	const folder = taskFolder(tasksDir, taskId)
	const input: RunInput = {}
	try {
		const manifest = await readJson(path.join(folder, "evaluation.json"))
		if (isRecord(manifest) && manifest.version === 1 && typeof manifest.taskId === "string") {
			input.manifest = manifest as unknown as RunInput["manifest"]
		} else {
			input.manifestError = "evaluation.json is not a version 1 manifest"
		}
	} catch (error) {
		input.manifestError = isMissing(error)
			? "no evaluation.json (task folder missing, or recording was off)"
			: "evaluation.json is not valid JSON"
	}
	try {
		input.metrics = summariseUiMessages(await readJson(path.join(folder, "ui_messages.json")))
	} catch (error) {
		input.metricsError = isMissing(error) ? "no ui_messages.json" : "ui_messages.json is not valid JSON"
	}
	try {
		// Count only. No value from the conversation history is printed (Q-SEC-2).
		const history = await readJson(path.join(folder, "api_conversation_history.json"))
		if (Array.isArray(history)) input.historyMessages = history.length
	} catch {
		// Optional.
	}
	return input
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT"
}

/** Reads a run's grades.json (path relative to the plan file) into the run input. */
async function addGrades(input: RunInput, planDir: string, gradesPath: string, phases: string[]): Promise<void> {
	let text: string
	try {
		text = await fs.readFile(path.resolve(planDir, gradesPath), "utf8")
	} catch (error) {
		input.gradesError = isMissing(error) ? `no grades file at ${gradesPath}` : `cannot read ${gradesPath}`
		return
	}
	const parsed = parseGrades(text)
	if (parsed.errors.length > 0) {
		input.gradesError = `${gradesPath}: ${parsed.errors[0]}`
		return
	}
	input.grades = summariseGrades(parsed.grades, phases)
}

async function matrix(argv: string[]): Promise<number> {
	const args = parseArgs(argv, ["plan", "tasks-dir"])
	const planPath = path.resolve(required(args, "plan"))
	const tasksDir = path.resolve(required(args, "tasks-dir"))
	const parsed = parsePlan(await fs.readFile(planPath, "utf8"))
	for (const error of parsed.errors) console.log(`plan: ${error}`)

	const inputs = new Map<string, RunInput>()
	for (const run of parsed.plan.runs) {
		if (!inputs.has(run.taskId)) {
			const input = await readRunInput(tasksDir, run.taskId)
			if (run.grades) await addGrades(input, path.dirname(planPath), run.grades, parsed.plan.phases ?? [])
			inputs.set(run.taskId, input)
		}
	}
	const report = evaluateMatrix(parsed.plan, inputs, parsed.duplicateTaskIds)
	const withGrades = parsed.plan.phases !== undefined || parsed.plan.runs.some((r) => r.grades !== undefined)

	const grouped =
		parsed.plan.cells.some((c) => c.group !== undefined) || parsed.plan.runs.some((r) => r.group !== undefined)
	const groupCol = (group: string | undefined) => (grouped ? [group ?? "-"] : [])
	const runLabel = (run: { scenario: string; group?: string; arm: string }) =>
		run.group === undefined ? `${run.scenario}/${run.arm}` : `${run.scenario}/${run.group}/${run.arm}`

	console.log(`\nRuns (build ${parsed.plan.build ?? "not set"}, ${parsed.plan.runs.length} runs)\n`)
	const header = [
		"task",
		"scenario",
		...(grouped ? ["group"] : []),
		"arm",
		"sample",
		"status",
		"stop",
		"requests",
		"tokens in",
		"tokens out",
		"cache read",
		"cache write",
		"cost",
		"history msgs",
	]
	const rows = report.runs.map((r) => [
		r.run.taskId.slice(0, 8),
		r.run.scenario,
		...groupCol(r.run.group),
		r.run.arm,
		r.run.sample ?? "",
		r.status,
		r.input.manifest?.stop?.reason ?? "-",
		...(r.input.metrics ? metricsCells(r.input.metrics) : ["-", "-", "-", "-", "-", "-"]),
		r.input.historyMessages === undefined ? "-" : String(r.input.historyMessages),
	])
	console.log(formatTable(header, rows))

	console.log("\nCells\n")
	console.log(
		formatTable(
			["scenario", ...(grouped ? ["group"] : []), "arm", "expected", "present", "scorable", "ok"],
			report.cells.map((c) => [
				c.cell.scenario,
				...groupCol(c.cell.group),
				c.cell.arm,
				String(c.cell.samples),
				String(c.present),
				String(c.scorable),
				c.ok ? "yes" : "NO",
			]),
		),
	)

	const problems = [
		...parsed.errors.map((e) => `plan: ${e}`),
		...report.planProblems,
		...report.runs.flatMap((r) => r.problems.map((p) => `${r.run.taskId.slice(0, 8)} (${runLabel(r.run)}): ${p}`)),
		...report.cells.flatMap((c) => c.problems),
	]
	const notes = report.runs.flatMap((r) => r.notes.map((n) => `${r.run.taskId.slice(0, 8)}: ${n}`))
	if (notes.length > 0) console.log(`\nNotes\n${notes.map((n) => `- ${n}`).join("\n")}`)
	if (problems.length > 0) console.log(`\nProblems\n${problems.map((p) => `- ${p}`).join("\n")}`)

	if (withGrades) {
		const phases =
			parsed.plan.phases ??
			[...new Set(report.runs.flatMap((r) => r.input.grades?.perPhase.map((p) => p.phase) ?? []))].sort(
				(a, b) => phaseIndex(a) - phaseIndex(b),
			)
		console.log("\nHidden tests per run (passed/total per phase; the last phase runs every earlier suite)\n")
		console.log(
			formatTable(
				[
					"task",
					...(grouped ? ["group"] : []),
					"arm",
					"sample",
					...phases,
					"final",
					"regressions",
					"score",
					"own tests",
				],
				report.runs.map((r) => {
					const g = r.input.grades
					return [
						r.run.taskId.slice(0, 8),
						...groupCol(r.run.group),
						r.run.arm,
						r.run.sample ?? "",
						...phases.map((phase) => {
							const p = g?.perPhase.find((x) => x.phase === phase)
							return p ? `${p.passed}/${p.total}` : "-"
						}),
						g?.final ? `${g.final.passed}/${g.final.total}` : "-",
						g ? String(g.regressions) : "-",
						g?.final ? String(g.score) : "-",
						g?.ownTestsPass === undefined ? "-" : g.ownTestsPass ? "pass" : "FAIL",
					]
				}),
			),
		)
		console.log(
			`\nHidden tests per arm${grouped ? " and group" : ""} (mean over valid graded runs; score = passed in the last phase minus regressions)\n`,
		)
		console.log(
			formatTable(
				[
					"scenario",
					...(grouped ? ["group"] : []),
					"arm",
					"graded",
					"passed",
					"total",
					"regressions",
					"score",
					"own tests pass",
				],
				report.means.map((m) => [
					m.scenario,
					...groupCol(m.group),
					m.arm,
					String(m.grades?.runs ?? 0),
					m.grades ? m.grades.finalPassed.toFixed(1) : "-",
					m.grades ? m.grades.finalTotal.toFixed(1) : "-",
					m.grades ? m.grades.regressions.toFixed(1) : "-",
					m.grades ? m.grades.score.toFixed(1) : "-",
					m.grades ? `${m.grades.ownTestsPassing}/${m.grades.runs}` : "-",
				]),
			),
		)
	}

	console.log(
		`\nMean per arm${grouped ? " and group" : ""} (valid runs only; excluded and invalid runs are left out)\n`,
	)
	console.log(
		formatTable(
			[
				"scenario",
				...(grouped ? ["group"] : []),
				"arm",
				"runs",
				"requests",
				"tokens in",
				"tokens out",
				"cache read",
				"cache write",
				"cost",
			],
			report.means.map((m) => [
				m.scenario,
				...groupCol(m.group),
				m.arm,
				String(m.runs),
				...metricsCells(m.mean, 1),
			]),
		),
	)

	const ok = report.ok && parsed.errors.length === 0
	console.log(`\n${ok ? "Matrix valid." : "Matrix INVALID."}`)
	return ok ? 0 : 1
}

// ---------------------------------------------------------------------------
// blind-export
// ---------------------------------------------------------------------------

interface WorkspaceEntry {
	path: string
	base: string
}

function parseWorkspaces(raw: unknown, mapDir: string): Map<string, WorkspaceEntry> {
	if (!isRecord(raw)) throw new UsageError("workspaces map must be a JSON object")
	const defaultBase = typeof raw.base === "string" ? raw.base : undefined
	const runs = isRecord(raw.runs) ? raw.runs : raw
	const result = new Map<string, WorkspaceEntry>()
	for (const [taskId, value] of Object.entries(runs)) {
		if (taskId === "base") continue
		const entryPath =
			typeof value === "string"
				? value
				: isRecord(value) && typeof value.path === "string"
					? value.path
					: undefined
		const base = isRecord(value) && typeof value.base === "string" ? value.base : defaultBase
		if (!entryPath) throw new UsageError(`workspaces.${taskId}: needs a path`)
		if (!base) throw new UsageError(`workspaces.${taskId}: needs a base commit (or set a top-level "base")`)
		result.set(taskId, { path: path.resolve(mapDir, entryPath), base })
	}
	return result
}

/**
 * Diff of a workspace against its base commit: tracked changes (`git diff <base>`, staged and
 * unstaged) plus each untracked, not ignored file as a new-file diff. Read-only: no index,
 * object or file in the workspace is written.
 */
async function workspaceDiff(entry: WorkspaceEntry): Promise<string> {
	const parts: string[] = []
	const tracked = await gitText(entry.path, ["diff", "--no-color", "--no-ext-diff", "--binary", entry.base, "--"])
	if (tracked.code !== 0) throw new Error(`git diff failed in ${entry.path}: ${tracked.stderr.split("\n")[0] ?? ""}`)
	if (tracked.text) parts.push(tracked.text)

	const untracked = await gitText(entry.path, ["ls-files", "--others", "--exclude-standard"])
	if (untracked.code !== 0)
		throw new Error(`git ls-files failed in ${entry.path}: ${untracked.stderr.split("\n")[0] ?? ""}`)
	const files = untracked.text
		.split("\n")
		.filter((f) => f.length > 0)
		.sort()
	for (const file of files) {
		// --no-index exits 1 when the files differ, which is the normal case here.
		const added = await gitText(entry.path, [
			"diff",
			"--no-index",
			"--no-color",
			"--no-ext-diff",
			"--binary",
			"--",
			os.devNull,
			file,
		])
		if (added.code > 1) throw new Error(`git diff --no-index failed for an untracked file in ${entry.path}`)
		if (added.text) parts.push(added.text)
	}
	return parts.length > 0 ? `${parts.join("\n")}\n` : ""
}

const cryptoRandom = {
	next: () => crypto.randomInt(0, 2 ** 31) / 2 ** 31,
	id: () => crypto.randomBytes(4).toString("hex"),
}

async function blindExport(argv: string[]): Promise<number> {
	const args = parseArgs(
		argv,
		["plan", "scenario", "group", "workspaces", "out", "protocol", "prompt-file", "arms"],
		["followups"],
	)
	const planPath = path.resolve(required(args, "plan"))
	const scenario = required(args, "scenario")
	const group = args.group
	const mapPath = path.resolve(required(args, "workspaces"))
	const outDir = path.resolve(required(args, "out"))
	if (args.protocol && args["prompt-file"]) throw new UsageError("Use --protocol or --prompt-file, not both")
	const protocolPath = path.resolve(args.protocol ?? DEFAULT_PROTOCOL)
	const onlyArms = args.arms
		? args.arms
				.split(",")
				.map((a) => a.trim())
				.filter(Boolean)
		: undefined
	if (onlyArms && onlyArms.length !== 2) throw new UsageError("--arms needs exactly two arm names, comma-separated")

	const parsed = parsePlan(await fs.readFile(planPath, "utf8"))
	if (parsed.errors.length > 0) {
		for (const error of parsed.errors) console.log(`plan: ${error}`)
		return 1
	}
	const taskPrompt = args["prompt-file"]
		? (await fs.readFile(path.resolve(args["prompt-file"]), "utf8")).trim()
		: extractScenarioPrompt(await fs.readFile(protocolPath, "utf8"), scenario)
	if (!taskPrompt) throw new UsageError(`No prompt for scenario ${scenario} in section 4 of ${protocolPath}`)
	const followups: string[] = []
	for (const file of many(args, "followups")) {
		const text = (await fs.readFile(path.resolve(file), "utf8")).trim()
		if (!text) throw new UsageError(`--followups ${file} is empty`)
		followups.push(text)
	}
	const workspaces = parseWorkspaces(await readJson(mapPath), path.dirname(mapPath))

	const pairing = pairRuns(parsed.plan, scenario, group, onlyArms)
	for (const problem of pairing.problems) console.log(problem)
	for (const run of pairing.unpaired) console.log(`unpaired run left out: ${run.taskId.slice(0, 8)} (${run.arm})`)
	if (pairing.pairs.length === 0) {
		console.log("No matched pairs to export.")
		return 1
	}
	const missing = pairing.pairs.flatMap((p) => p.runs).filter((r) => !workspaces.has(r.taskId))
	if (missing.length > 0) {
		for (const run of missing) console.log(`no workspace for ${run.taskId}`)
		return 1
	}

	const keyPath = path.join(outDir, "key.json")
	const judgeDir = path.join(outDir, "judge")
	if ((await exists(keyPath)) || (await exists(judgeDir))) {
		throw new UsageError(`${outDir} already has an export. Use a new --out folder.`)
	}

	const { assignments, key } = assignBlind(scenario, pairing.pairs, cryptoRandom, new Date(), group)
	for (const assignment of assignments) {
		const pairDir = path.join(judgeDir, assignment.pairId)
		await fs.mkdir(pairDir, { recursive: true })
		for (const side of ["A", "B"] as const) {
			const run = assignment[side]
			const diff = await workspaceDiff(workspaces.get(run.taskId)!)
			await fs.writeFile(path.join(pairDir, `${side}.diff`), diff, "utf8")
			const mentions = Object.entries(countArmMentions(diff, pairing.arms)).filter(([, n]) => n > 0)
			if (mentions.length > 0) {
				// The arm is not printed next to the pair, so the operator stays blind too.
				console.log(
					`warning: ${assignment.pairId}/${side}.diff has added lines that contain an arm name; review before judging.`,
				)
			}
		}
		await fs.writeFile(
			path.join(pairDir, "judge-prompt.md"),
			buildJudgePrompt(assignment.pairId, taskPrompt, followups),
			"utf8",
		)
	}
	await safeWriteJson(keyPath, key, { prettyPrint: true })
	const template: Record<string, string> = {}
	for (const assignment of assignments) template[assignment.pairId] = ""
	await safeWriteJson(path.join(outDir, "answers.template.json"), template, { prettyPrint: true })

	console.log(`Exported ${assignments.length} pair(s) for ${scenario}${group !== undefined ? `/${group}` : ""}.`)
	console.log(`Judge folder (give only this to the judge): ${judgeDir}`)
	console.log(`Key (keep away from the judge): ${keyPath}`)
	console.log(`Answers template: ${path.join(outDir, "answers.template.json")}`)
	return 0
}

// ---------------------------------------------------------------------------
// blind-score
// ---------------------------------------------------------------------------

async function blindScore(argv: string[]): Promise<number> {
	const args = parseArgs(argv, ["out", "answers"])
	const outDir = path.resolve(required(args, "out"))
	const key = (await readJson(path.join(outDir, "key.json"))) as BlindKey
	if (!isRecord(key) || key.version !== 1 || !isRecord(key.pairs))
		throw new UsageError("key.json is not a version 1 key")
	const answers = await readJson(path.resolve(required(args, "answers")))
	if (!isRecord(answers)) throw new UsageError("answers must be a JSON object keyed by pair ID")

	const score = scoreBlind(key, answers)
	const reviewLabel = typeof key.group === "string" ? `${key.scenario}/${key.group}` : key.scenario
	console.log(`Blind review ${reviewLabel}: ${score.answered} of ${Object.keys(key.pairs).length} pairs answered.\n`)
	console.log(
		formatTable(
			["pair", "sample", "winner arm", "winner task"],
			score.perPair.map((p) => [p.pairId, p.sample, p.winnerArm, p.winnerTaskId.slice(0, 8)]),
		),
	)
	console.log("\nWins per arm\n")
	console.log(
		formatTable(
			["arm", "wins"],
			Object.entries(score.wins).map(([arm, n]) => [arm, String(n)]),
		),
	)
	for (const id of score.missing) console.log(`missing answer: ${id}`)
	for (const id of score.invalid) console.log(`invalid answer (needs exactly one choice block with A or B): ${id}`)
	for (const id of score.unknown) console.log(`answer for unknown pair ignored: ${id}`)
	return score.missing.length + score.invalid.length === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// grade
// ---------------------------------------------------------------------------

/** Seed data file for the server under test, relative to the hidden tests folder. */
const SEED_FIXTURE = path.join("fixtures", "seed-expenses.json")
const OUTPUT_LIMIT = 200_000

interface RunResult {
	code: number | null
	signal: NodeJS.Signals | null
	timedOut: boolean
	output: string
}

/** True when `child` is inside `parent` (or equal to it). */
function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child)
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

/** Sends a signal to the child's process group (POSIX), falling back to the child itself. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.pid === undefined) return
	try {
		process.kill(-child.pid, signal)
	} catch {
		try {
			child.kill(signal)
		} catch {
			// Already gone.
		}
	}
}

/** Runs a command in its own process group with a timeout; output is kept up to OUTPUT_LIMIT characters. */
function runBounded(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let output = ""
		const collect = (chunk: Buffer) => {
			if (output.length < OUTPUT_LIMIT) output += chunk.toString("utf8")
		}
		child.stdout?.on("data", collect)
		child.stderr?.on("data", collect)
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			killGroup(child, "SIGTERM")
			setTimeout(() => killGroup(child, "SIGKILL"), 3000).unref()
		}, options.timeoutMs)
		child.on("error", (error) => {
			clearTimeout(timer)
			resolve({ code: null, signal: null, timedOut, output: `${output}\n${error.message}` })
		})
		child.on("close", (code, signal) => {
			clearTimeout(timer)
			// Kill any descendants left in the group (for example a server started by the tests).
			killGroup(child, "SIGKILL")
			resolve({ code, signal, timedOut, output })
		})
	})
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer()
		server.unref()
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			const port = typeof address === "object" && address ? address.port : 0
			server.close(() => (port ? resolve(port) : reject(new Error("no free port"))))
		})
	})
}

function portAnswers(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port })
		const done = (ok: boolean) => {
			socket.destroy()
			resolve(ok)
		}
		socket.setTimeout(1000, () => done(false))
		socket.once("connect", () => done(true))
		socket.once("error", () => done(false))
	})
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `git status --porcelain` lines of the workspace, excluding node_modules. Undefined when the workspace is
 * not the top level of its own git work tree (for example a folder inside another repository).
 */
async function workspaceStatus(workspace: string): Promise<Set<string> | undefined> {
	const top = await gitText(workspace, ["rev-parse", "--show-toplevel"]).catch(() => undefined)
	if (!top || top.code !== 0) return undefined
	const realTop = await fs.realpath(top.text.trim()).catch(() => top.text.trim())
	const realWorkspace = await fs.realpath(workspace).catch(() => workspace)
	if (realTop !== realWorkspace) return undefined
	const result = await gitText(workspace, ["status", "--porcelain", "--untracked-files=all"]).catch(() => undefined)
	if (!result || result.code !== 0) return undefined
	return new Set(
		result.text
			.split("\n")
			.filter(
				(line) =>
					line.length > 0 &&
					!/(^|\/)node_modules\//.test(line.slice(3)) &&
					!line.slice(3).startsWith("node_modules"),
			),
	)
}

/** Environment for workspace processes: the parent environment without npm's own config overrides. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("npm_") || key === "INIT_CWD" || key === "PORT" || key === "BASE_URL") continue
		env[key] = value
	}
	return { ...env, ...extra }
}

function tail(text: string, lines: number): string {
	return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n")
}

async function grade(argv: string[]): Promise<number> {
	const args = parseArgs(argv, [
		"workspace",
		"phase",
		"tests",
		"out",
		"amount-mode",
		"start-timeout",
		"test-timeout",
		"own-test-timeout",
	])
	const workspace = path.resolve(required(args, "workspace"))
	const phase = required(args, "phase")
	if (!PHASE_PATTERN.test(phase)) throw new UsageError(`--phase must look like P1, got ${phase}`)
	const testsDir = path.resolve(required(args, "tests"))
	const outPath = path.resolve(required(args, "out"))
	const amountArg = args["amount-mode"]
	if (amountArg !== undefined && amountArg !== "decimal" && amountArg !== "cents") {
		throw new UsageError("--amount-mode must be decimal or cents")
	}
	// L1: amounts are decimal until P4 changes them to cents.
	const amountMode: AmountMode =
		(amountArg as AmountMode | undefined) ?? (phaseIndex(phase) >= 4 ? "cents" : "decimal")
	const startTimeoutMs = optionalInt(args, "start-timeout", 30) * 1000
	const testTimeoutMs = optionalInt(args, "test-timeout", 120) * 1000
	const ownTestTimeoutMs = optionalInt(args, "own-test-timeout", 300) * 1000

	if (!(await exists(path.join(workspace, "package.json")))) throw new UsageError(`${workspace} has no package.json`)
	if (isInside(workspace, testsDir))
		throw new UsageError("--tests is inside the workspace; the hidden tests must stay outside it")
	if (isInside(workspace, outPath))
		throw new UsageError("--out is inside the workspace; grade must not write to the workspace")

	const testFiles = selectPhaseTestFiles(await fs.readdir(testsDir), phase)
	if (!testFiles.some((f) => f === `${phase}.test.mjs`)) throw new UsageError(`${testsDir} has no ${phase}.test.mjs`)

	const existing = parseGrades((await exists(outPath)) ? await fs.readFile(outPath, "utf8") : undefined)
	if (existing.errors.length > 0) throw new UsageError(`${outPath}: ${existing.errors.join("; ")}`)

	// 1. Copy the hidden tests and the seed data to a temporary folder outside the workspace.
	const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eval-grade-"))
	if (isInside(workspace, tmp)) throw new Error("temporary folder is inside the workspace")
	const notes: string[] = []
	let server: ChildProcess | undefined
	try {
		const tmpTests = path.join(tmp, "tests")
		await fs.mkdir(tmpTests)
		for (const file of testFiles) await fs.copyFile(path.join(testsDir, file), path.join(tmpTests, file))
		const dataFile = path.join(tmp, "data", "expenses.json")
		await fs.mkdir(path.dirname(dataFile))
		if (await exists(path.join(testsDir, SEED_FIXTURE))) {
			await fs.copyFile(path.join(testsDir, SEED_FIXTURE), dataFile)
		} else {
			notes.push(`no ${SEED_FIXTURE} in the tests folder: the server starts without seed data`)
		}
		console.log(`Grading ${phase} (${amountMode}) of ${workspace} with ${testFiles.join(", ")}.`)

		const statusBefore = await workspaceStatus(workspace)

		// 2. npm install when node_modules is missing.
		if (!(await exists(path.join(workspace, "node_modules")))) {
			console.log("node_modules missing: running npm install.")
			const install = await runBounded("npm", ["install", "--no-audit", "--no-fund"], {
				cwd: workspace,
				env: childEnv({}),
				timeoutMs: 300_000,
			})
			if (install.code !== 0) {
				notes.push(
					`npm install failed (exit ${install.code ?? install.signal}${install.timedOut ? ", timed out" : ""})`,
				)
				console.log(tail(install.output, 20))
			}
		}

		// 3. npm start on a free port; wait until the port answers.
		const port = await freePort()
		const baseUrl = `http://127.0.0.1:${port}`
		let serverOutput = ""
		let serverExited = false
		server = spawn("npm", ["start"], {
			cwd: workspace,
			env: childEnv({ PORT: String(port), DATA_FILE: dataFile }),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		const collect = (chunk: Buffer) => {
			if (serverOutput.length < OUTPUT_LIMIT) serverOutput += chunk.toString("utf8")
		}
		server.stdout?.on("data", collect)
		server.stderr?.on("data", collect)
		server.on("exit", () => {
			serverExited = true
		})
		server.on("error", (error) => {
			serverExited = true
			serverOutput += `\n${error.message}`
		})
		const started = Date.now()
		let serverStarted = false
		while (Date.now() - started < startTimeoutMs && !serverExited) {
			if (await portAnswers(port)) {
				serverStarted = true
				break
			}
			await sleep(250)
		}
		if (serverStarted) {
			console.log(`Server answered on port ${port} after ${((Date.now() - started) / 1000).toFixed(1)} s.`)
		} else {
			const why = serverExited
				? "npm start exited"
				: `port ${port} did not answer within ${startTimeoutMs / 1000} s`
			notes.push(`server not started: ${why}`)
			console.log(`Server not started: ${why}. Last output:\n${tail(serverOutput, 20)}`)
		}

		// 4. Hidden tests, one file at a time, with BASE_URL set.
		const files: Array<{ file: string; tests: TapTest[] }> = []
		for (const file of testFiles) {
			const result = await runBounded(process.execPath, ["--test", "--test-reporter=tap", file], {
				cwd: tmpTests,
				env: childEnv({ BASE_URL: baseUrl, AMOUNT_MODE: amountMode }),
				timeoutMs: testTimeoutMs,
			})
			const tests = parseTap(result.output, file)
			if (result.timedOut) notes.push(`${file}: timed out after ${testTimeoutMs / 1000} s`)
			if (tests.length === 0) notes.push(`${file}: no test results (exit ${result.code ?? result.signal})`)
			files.push({ file, tests })
		}

		// 5. Stop the server and its process group before the project's own tests.
		killGroup(server, "SIGTERM")
		for (let i = 0; i < 20 && !serverExited; i++) await sleep(250)
		killGroup(server, "SIGKILL")
		server = undefined

		// 6. The project's own npm test.
		const own = await runBounded("npm", ["test"], {
			cwd: workspace,
			env: childEnv({ CI: "1" }),
			timeoutMs: ownTestTimeoutMs,
		})
		const ownTestsPass = own.code === 0 && !own.timedOut
		if (own.timedOut) notes.push(`npm test timed out after ${ownTestTimeoutMs / 1000} s`)

		const statusAfter = await workspaceStatus(workspace)
		const workspaceChanges =
			statusBefore && statusAfter ? [...statusAfter].filter((line) => !statusBefore.has(line)).sort() : undefined
		if (workspaceChanges && workspaceChanges.length > 0) {
			notes.push(
				`workspace changed while grading (by npm install, the server or npm test): ${workspaceChanges.length} path(s)`,
			)
		}

		// 7. Record the phase.
		const collected = collectResults(files)
		const regressions = computeRegressions(existing.grades.entries, phase, collected.results)
		const entry: GradeEntry = {
			phase,
			amountMode,
			gradedAt: new Date().toISOString(),
			testsPassed: collected.passed,
			testsFailed: collected.failed,
			perFile: collected.perFile,
			ownTestsPass,
			regressions,
			results: collected.results,
			serverStarted,
			...(workspaceChanges ? { workspaceChanges } : {}),
			...(notes.length > 0 ? { notes } : {}),
		}
		const replaced = existing.grades.entries.some((e) => e.phase === phase)
		await safeWriteJson(outPath, upsertGradeEntry(existing.grades, entry), { prettyPrint: true })

		console.log("")
		console.log(
			formatTable(
				["file", "passed", "failed"],
				Object.entries(collected.perFile).map(([file, r]) => [file, String(r.passed), String(r.failed)]),
			),
		)
		const failedIds = Object.entries(collected.results)
			.filter(([, outcome]) => outcome === "fail")
			.map(([id]) => id)
		if (failedIds.length > 0) console.log(`\nFailed:\n${failedIds.map((id) => `- ${id}`).join("\n")}`)
		if (regressions.length > 0) console.log(`\nRegressions:\n${regressions.map((id) => `- ${id}`).join("\n")}`)
		if (!ownTestsPass)
			console.log(`\nnpm test failed (exit ${own.code ?? own.signal}). Last output:\n${tail(own.output, 15)}`)
		for (const note of notes) console.log(`note: ${note}`)
		console.log(
			`\n${phase}: ${collected.passed} passed, ${collected.failed} failed, ${regressions.length} regressions, own tests ${ownTestsPass ? "pass" : "FAIL"}.`,
		)
		console.log(`${replaced ? "Replaced" : "Added"} ${phase} in ${outPath}.`)
		return collected.failed === 0 && ownTestsPass && serverStarted ? 0 : 1
	} finally {
		if (server) killGroup(server, "SIGKILL")
		await fs.rm(tmp, { recursive: true, force: true })
	}
}

// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
	"leak-check": leakCheck,
	matrix,
	"blind-export": blindExport,
	"blind-score": blindScore,
	grade,
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"))
	const [command, ...rest] = argv
	if (!command || command === "--help" || command === "-h" || command === "help") {
		console.log(USAGE)
		return 0
	}
	const run = COMMANDS[command]
	if (!run) throw new UsageError(`Unknown command: ${command}`)
	if (rest.includes("--help") || rest.includes("-h")) {
		console.log(USAGE)
		return 0
	}
	return run(rest)
}

main()
	.then((code) => {
		process.exitCode = code
	})
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		if (error instanceof UsageError) console.error(`\n${USAGE}`)
		process.exitCode = 2
	})
