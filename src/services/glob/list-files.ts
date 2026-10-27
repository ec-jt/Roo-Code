import os from "os"
import * as path from "path"
import ignore, { type Ignore } from "ignore"
import { arePathsEqual } from "../../utils/path"
import { DIRS_TO_IGNORE } from "./constants"
import { ListingProcess } from "./listing-process"

export interface ListFilesOptions {
	signal?: AbortSignal
	timeoutMs?: number
	maxEntries?: number
	maxDepth?: number
	/** Cached policy text. No policy files are read by the listing operation. */
	policy?: { cwd: string; content: string }
}
export type ListFilesResult = [string[], boolean] & {
	/** A nonempty reason means this is not a complete directory listing. */
	reason?: string
	ignoredPaths?: Set<string>
}
type Entry = { name: string; directory: boolean; symlink: boolean }
type Rule = { base: string; matcher: Ignore }
const CRITICAL = new Set(["node_modules", ".git", "__pycache__", "venv", "env"])
const VIRTUAL_ROOTS = ["/proc", "/sys", "/dev"]

function within(base: string, target: string): boolean {
	const relative = path.relative(base, target)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}
function virtual(target: string): boolean {
	return process.platform !== "win32" && VIRTUAL_ROOTS.some((base) => within(base, target))
}
function ignored(rule: Rule, target: string, directory: boolean): boolean {
	const relative = path.relative(rule.base, target).split(path.sep).join("/")
	return !!relative && within(rule.base, target) && rule.matcher.ignores(relative + (directory ? "/" : ""))
}

function gitIgnored(rules: Rule[], target: string, directory: boolean): boolean {
	let excluded = false
	for (const rule of rules) {
		const relative = path.relative(rule.base, target).split(path.sep).join("/")
		if (!relative || !within(rule.base, target)) continue
		const result = rule.matcher.test(relative + (directory ? "/" : ""))
		if (result.ignored) excluded = true
		else if (result.unignored) excluded = false
	}
	return excluded
}

/**
 * Bounded breadth-first listing. All filesystem calls run in a killable Node child.
 * Shallow mode reads entries only. Recursive mode reads regular, size-limited
 * .gitignore files, but never follows discovered symbolic links.
 * The tuple remains compatible with existing callers; reasons distinguish partial results.
 */
export async function listFiles(
	dirPath: string,
	recursive: boolean,
	limit: number,
	options: ListFilesOptions = {},
): Promise<ListFilesResult> {
	if (options.signal?.aborted) throw options.signal.reason ?? new Error("Directory listing cancelled")
	if (limit === 0) return [[], false]
	if (!Number.isSafeInteger(limit) || limit < 0)
		throw new Error("Directory listing limit must be a nonnegative integer")
	limit = Math.min(limit, 50_000)
	const absolutePath = path.resolve(dirPath)
	const root = path.parse(absolutePath).root
	if (arePathsEqual(absolutePath, root) || arePathsEqual(absolutePath, os.homedir())) return [[absolutePath], false]

	const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 10_000, 10_000))
	const deadline = Date.now() + timeoutMs
	const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 100_000, 100_000))
	const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 32, 32))
	const policy = options.policy?.content
		? { base: path.resolve(options.policy.cwd), matcher: ignore().add(options.policy.content).add(".rooignore") }
		: undefined
	let canonicalPolicy: Rule | undefined
	const deniedByPolicy = (target: string, directory: boolean) =>
		!!(
			(policy && ignored(policy, target, directory)) ||
			(canonicalPolicy && ignored(canonicalPolicy, target, directory))
		)
	const worker = new ListingProcess()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		worker.stop(new Error("Directory listing deadline reached"))
	}, timeoutMs)
	const onAbort = () => worker.stop(new Error("Directory listing cancelled"))
	options.signal?.addEventListener("abort", onAbort, { once: true })
	const results: string[] = []
	const blocked = new Set<string>()
	let reason: string | undefined
	let inspected = 0
	let ignoreBytes = 0
	const check = () => {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Directory listing cancelled")
		if (timedOut || Date.now() >= deadline) {
			timedOut = true
			throw new Error("Directory listing deadline reached")
		}
	}
	const readIgnore = async (base: string, rules: Rule[]): Promise<Rule[]> => {
		check()
		const filename = path.join(base, ".gitignore")
		if (deniedByPolicy(filename, false)) return rules
		const content = await worker.request<string>("ignore", filename)
		ignoreBytes += Buffer.byteLength(content)
		if (ignoreBytes > 1024 * 1024) throw new Error("Directory listing ignore-file budget reached")
		return content ? [...rules, { base, matcher: ignore().add(content) }] : rules
	}
	try {
		check()
		if (deniedByPolicy(absolutePath, true)) throw new Error("Directory listing denied by .rooignore")
		if (policy) canonicalPolicy = { ...policy, base: await worker.request<string>("realpath", policy.base) }
		const realRoot = await worker.request<string>("realpath", absolutePath)
		check()
		if (deniedByPolicy(realRoot, true)) throw new Error("Directory listing denied by .rooignore")
		if (arePathsEqual(realRoot, path.parse(realRoot).root) || arePathsEqual(realRoot, os.homedir()))
			return [[realRoot], false]
		if (recursive && virtual(realRoot)) {
			recursive = false
			reason = "Recursive traversal of virtual filesystems is disabled; only direct entries are shown."
		}
		const explicitHidden = absolutePath.split(path.sep).some((part) => part.startsWith("."))
		const explicitIgnored = DIRS_TO_IGNORE.includes(path.basename(absolutePath))
		let rules: Rule[] = []
		if (recursive && !explicitHidden && !explicitIgnored) {
			const ancestors: string[] = []
			for (
				let current = path.dirname(realRoot);
				current !== path.dirname(current);
				current = path.dirname(current)
			) {
				if (ancestors.length >= 32) throw new Error("Directory listing ancestor depth budget reached")
				ancestors.unshift(current)
			}
			for (const ancestor of ancestors) rules = await readIgnore(ancestor, rules)
		}
		const queue = [{ real: realRoot, display: absolutePath, depth: 0, rules }]
		scan: for (let index = 0; index < queue.length; index++) {
			check()
			const current = queue[index]
			try {
				await worker.request("open", current.real)
				let localRules = current.rules
				if (recursive && !explicitHidden && !explicitIgnored)
					localRules = await readIgnore(current.real, localRules)
				while (true) {
					check()
					const entries = await worker.request<Entry[]>("read")
					for (const entry of entries) {
						check()
						if (++inspected > maxEntries) {
							reason = "Directory listing entry-work budget reached."
							break scan
						}
						const display = path.join(current.display, entry.name)
						const real = path.join(current.real, entry.name)
						const isDirectory = entry.directory && !entry.symlink
						const formatted = display + (isDirectory ? "/" : "")
						const denied = deniedByPolicy(display, isDirectory) || deniedByPolicy(real, isDirectory)
						if (denied) blocked.add(path.resolve(display))
						if (
							isDirectory &&
							(explicitHidden
								? CRITICAL.has(entry.name)
								: DIRS_TO_IGNORE.some((item) => item !== ".*" && item.split("/")[0] === entry.name))
						)
							continue
						if (gitIgnored(localRules, real, isDirectory)) continue
						results.push(formatted)
						if (results.length >= limit) break scan
						if (recursive && isDirectory && !denied && (!entry.name.startsWith(".") || explicitHidden)) {
							if (virtual(real)) reason = "Virtual filesystem subdirectories were not traversed."
							else if (current.depth >= maxDepth) reason = "Directory listing depth budget reached."
							else queue.push({ real, display, depth: current.depth + 1, rules: localRules })
						}
					}
					if (entries.length < 32) break
				}
			} catch (error) {
				check()
				if (index === 0) throw error
				reason = "Some entries disappeared or could not be read; this listing is partial."
			}
		}
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("Directory listing cancelled")
		if (!results.length)
			throw new Error(timedOut ? "Directory listing timed out; no complete listing is available." : String(error))
		reason = timedOut
			? "Directory listing timed out; these are partial results."
			: `Directory listing stopped: ${String(error)}`
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", onAbort)
		worker.stop()
	}
	results.sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
	const result: ListFilesResult = [results, results.length >= limit || !!reason]
	if (reason) result.reason = reason
	if (blocked.size) result.ignoredPaths = blocked
	return result
}
