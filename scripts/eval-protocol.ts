/**
 * Evaluation protocol tooling (developer only, not shipped in the VSIX).
 * ADR-2026-11-20-feature-gating-evaluation-and-lessons, R-6. Usage: docs/eval-protocol-tooling.md.
 *
 *   pnpm eval:protocol leak-check   --workspace <dir> --protocol <file> [--extra <strings-file>]
 *   pnpm eval:protocol matrix       --plan <plan.json> --tasks-dir <globalStorage>/tasks
 *   pnpm eval:protocol blind-export --plan <plan.json> --scenario S2 --workspaces <map.json> --out <dir>
 *   pnpm eval:protocol blind-score  --out <dir> --answers <answers.json>
 *
 * Constraints: reads only the task folders named in the plan and never writes task storage (C-5);
 * prints counts only from api_conversation_history.json and no environment values (Q-SEC-2);
 * calls no model API and reads no API key.
 */
import { spawn } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as readline from "readline"

import { safeWriteJson } from "../src/utils/safeWriteJson"

import {
	type BlindKey,
	type LeakHit,
	type Needle,
	type RunInput,
	LEAK_SKIP_DIRECTORIES,
	PatchCursor,
	SAFE_TASK_ID,
	assignBlind,
	buildJudgePrompt,
	buildNeedles,
	countArmMentions,
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
	parsePlan,
	scanPath,
	scanText,
	scoreBlind,
	summariseUiMessages,
} from "./eval-protocol/lib"

const DEFAULT_PROTOCOL = "docs/architecture/evaluation-2026-11-18.md"

const USAGE = `Usage: pnpm eval:protocol <command> [options]

Commands:
  leak-check    --workspace <dir> --protocol <file> [--extra <strings-file>]
                [--max-file-bytes <n>] [--max-commits <n>] [--max-print <n>]
      Fails (exit 1) if the workspace contains the protocol file name or a scripted
      string (section 4 blockquotes and italic quotes, plus extra lines) in any file,
      in "git diff HEAD", or in "git log -p --all". Skips node_modules and .git.

  matrix        --plan <plan.json> --tasks-dir <globalStorage>/tasks
      Checks the planned cells against each run's evaluation.json and prints
      requests, tokens, cache and cost per run and the mean per arm. Reads only
      the task folders listed in plan.runs. Exit 1 if any cell is invalid.

  blind-export  --plan <plan.json> --scenario <id> --workspaces <map.json> --out <dir>
                [--protocol <file>]
      Writes one anonymised folder per matched pair under <out>/judge/ (A.diff,
      B.diff, judge-prompt.md), and <out>/key.json outside it. Calls no model.

  blind-score   --out <dir> --answers <answers.json>
      Joins the judge's choices to the arms with <out>/key.json and prints wins.

Default --protocol: ${DEFAULT_PROTOCOL}`

type Args = Record<string, string>

function parseArgs(argv: string[], allowed: string[]): Args {
	const args: Args = {}
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!
		if (arg === "--") continue
		if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`)
		const name = arg.slice(2)
		if (!allowed.includes(name)) throw new UsageError(`Unknown option: ${arg}`)
		const value = argv[i + 1]
		if (value === undefined || value.startsWith("--")) throw new UsageError(`Option ${arg} needs a value`)
		args[name] = value
		i++
	}
	return args
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

async function leakCheck(argv: string[]): Promise<number> {
	const args = parseArgs(argv, ["workspace", "protocol", "extra", "max-file-bytes", "max-commits", "max-print"])
	const workspace = path.resolve(required(args, "workspace"))
	const protocolPath = path.resolve(required(args, "protocol"))
	const maxFileBytes = optionalInt(args, "max-file-bytes", 5 * 1024 * 1024)
	const maxCommits = optionalInt(args, "max-commits", 0)
	const maxPrint = optionalInt(args, "max-print", 200)

	const protocolText = await fs.readFile(protocolPath, "utf8")
	const scripted = extractScriptedStrings(protocolText)
	const extra = args.extra ? parseExtraStrings(await fs.readFile(path.resolve(args.extra), "utf8")) : []
	const needles = buildNeedles(path.basename(protocolPath), scripted, extra)
	console.log(
		`Leak check of ${workspace}: protocol file name, ${scripted.length} scripted strings, ${extra.length} extra strings.`,
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

async function matrix(argv: string[]): Promise<number> {
	const args = parseArgs(argv, ["plan", "tasks-dir"])
	const planPath = path.resolve(required(args, "plan"))
	const tasksDir = path.resolve(required(args, "tasks-dir"))
	const parsed = parsePlan(await fs.readFile(planPath, "utf8"))
	for (const error of parsed.errors) console.log(`plan: ${error}`)

	const inputs = new Map<string, RunInput>()
	for (const run of parsed.plan.runs) {
		if (!inputs.has(run.taskId)) inputs.set(run.taskId, await readRunInput(tasksDir, run.taskId))
	}
	const report = evaluateMatrix(parsed.plan, inputs, parsed.duplicateTaskIds)

	console.log(`\nRuns (build ${parsed.plan.build ?? "not set"}, ${parsed.plan.runs.length} runs)\n`)
	const header = [
		"task",
		"scenario",
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
			["scenario", "arm", "expected", "present", "scorable", "ok"],
			report.cells.map((c) => [
				c.cell.scenario,
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
		...report.runs.flatMap((r) =>
			r.problems.map((p) => `${r.run.taskId.slice(0, 8)} (${r.run.scenario}/${r.run.arm}): ${p}`),
		),
		...report.cells.flatMap((c) => c.problems),
	]
	const notes = report.runs.flatMap((r) => r.notes.map((n) => `${r.run.taskId.slice(0, 8)}: ${n}`))
	if (notes.length > 0) console.log(`\nNotes\n${notes.map((n) => `- ${n}`).join("\n")}`)
	if (problems.length > 0) console.log(`\nProblems\n${problems.map((p) => `- ${p}`).join("\n")}`)

	console.log("\nMean per arm (valid runs only; excluded and invalid runs are left out)\n")
	console.log(
		formatTable(
			["scenario", "arm", "runs", "requests", "tokens in", "tokens out", "cache read", "cache write", "cost"],
			report.means.map((m) => [m.scenario, m.arm, String(m.runs), ...metricsCells(m.mean, 1)]),
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
	const args = parseArgs(argv, ["plan", "scenario", "workspaces", "out", "protocol"])
	const planPath = path.resolve(required(args, "plan"))
	const scenario = required(args, "scenario")
	const mapPath = path.resolve(required(args, "workspaces"))
	const outDir = path.resolve(required(args, "out"))
	const protocolPath = path.resolve(args.protocol ?? DEFAULT_PROTOCOL)

	const parsed = parsePlan(await fs.readFile(planPath, "utf8"))
	if (parsed.errors.length > 0) {
		for (const error of parsed.errors) console.log(`plan: ${error}`)
		return 1
	}
	const taskPrompt = extractScenarioPrompt(await fs.readFile(protocolPath, "utf8"), scenario)
	if (!taskPrompt) throw new UsageError(`No prompt for scenario ${scenario} in section 4 of ${protocolPath}`)
	const workspaces = parseWorkspaces(await readJson(mapPath), path.dirname(mapPath))

	const pairing = pairRuns(parsed.plan, scenario)
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

	const { assignments, key } = assignBlind(scenario, pairing.pairs, cryptoRandom)
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
			buildJudgePrompt(assignment.pairId, taskPrompt),
			"utf8",
		)
	}
	await safeWriteJson(keyPath, key, { prettyPrint: true })
	const template: Record<string, string> = {}
	for (const assignment of assignments) template[assignment.pairId] = ""
	await safeWriteJson(path.join(outDir, "answers.template.json"), template, { prettyPrint: true })

	console.log(`Exported ${assignments.length} pair(s) for ${scenario}.`)
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
	console.log(`Blind review ${key.scenario}: ${score.answered} of ${Object.keys(key.pairs).length} pairs answered.\n`)
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

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
	"leak-check": leakCheck,
	matrix,
	"blind-export": blindExport,
	"blind-score": blindScore,
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
