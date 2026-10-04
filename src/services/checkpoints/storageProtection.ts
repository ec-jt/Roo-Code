import fs from "fs/promises"
import path from "path"
import ignore from "ignore"
import type { SimpleGit } from "simple-git"

// Checkpoints are source snapshots, not dataset/model backups. This also covers
// unknown extensions and extensionless artifacts without excluding models/.
export const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024

export const splitGitPaths = (output: string) => output.split("\0").filter(Boolean)

// Bound command-line length on Windows too; literal pathspecs prevent wildcard,
// leading dash and pathspec-magic filenames from expanding to unchecked files.
export function* pathBatches(paths: string[]): Generator<string[]> {
	let batch: string[] = []
	let length = 0
	for (const file of paths) {
		if (length + file.length > 8_000 && batch.length) {
			yield batch
			batch = []
			length = 0
		}
		batch.push(file)
		length += file.length + 1
	}
	if (batch.length) yield batch
}

export class CheckpointStorageProtection {
	private readonly excludes

	constructor(
		private readonly workspaceDir: string,
		patterns: string[],
	) {
		this.excludes = ignore().add(patterns)
	}

	isExcluded(file: string): boolean {
		return this.excludes.ignores(file)
	}

	/** Metadata only. Never traverse a symlink, including a symlinked parent. */
	async inspect(file: string): Promise<"safe" | "missing" | "protected"> {
		if (this.isExcluded(file)) return "protected"
		const parts = file.split("/")
		let current = this.workspaceDir
		for (let i = 0; i < parts.length; i++) {
			current = path.join(current, parts[i])
			let stat
			try {
				stat = await fs.lstat(current)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
				// Permission and I/O failures must abort, not silently produce a partial snapshot.
				throw error
			}
			if (stat.isSymbolicLink()) return "protected"
			if (i < parts.length - 1) {
				if (!stat.isDirectory()) return "protected"
			} else if (!stat.isFile() || stat.size > MAX_CHECKPOINT_FILE_BYTES) {
				return "protected"
			}
		}
		return "safe"
	}

	async list(git: SimpleGit, ...args: string[]) {
		return splitGitPaths(await git.raw(["ls-files", "-z", ...args]))
	}

	async stage(git: SimpleGit) {
		const tracked = new Set(await this.list(git, "--cached"))
		const ignored = new Set(await this.list(git, "--cached", "--ignored", "--exclude-standard"))
		// Git prunes ignored directories; do not walk datasets, node_modules or LFS trees ourselves.
		const candidates = new Set([...tracked, ...(await this.list(git, "--others", "--exclude-standard"))])
		const remove: string[] = []
		const add: string[] = []
		for (const file of candidates) {
			const state = ignored.has(file) ? "protected" : await this.inspect(file)
			if (state !== "safe") {
				if (tracked.has(file)) remove.push(file)
			} else {
				add.push(file)
			}
		}
		for (const batch of pathBatches(remove)) {
			// Index-only removal preserves working files, even when already tracked by an old checkpoint.
			await git.raw(["--literal-pathspecs", "rm", "--cached", "-f", "--", ...batch])
		}
		for (const batch of pathBatches(add)) {
			// Recheck just before ingestion. Git cannot atomically combine lstat with add:
			// an external writer can still grow/replace a file between this check and Git's read.
			for (const file of batch) {
				if ((await this.inspect(file)) !== "safe") {
					throw new Error("Checkpoint file changed during staging; retry after workspace writes finish")
				}
			}
			await git.raw(["--literal-pathspecs", "add", "--", ...batch])
		}
		// Catch growth during Git's read (or a clean filter expanding the content).
		// Such a race can already have written an object, but must not publish a
		// successful oversized checkpoint. Do not prune objects or rewrite history.
		const stagedTree = (await git.raw(["write-tree"])).trim()
		const oversized = (await this.tree(git, stagedTree))
			.filter((entry) => entry.size > MAX_CHECKPOINT_FILE_BYTES)
			.map((entry) => entry.file)
		if (oversized.length) {
			for (const batch of pathBatches(oversized)) {
				await git.raw(["--literal-pathspecs", "rm", "--cached", "-f", "--", ...batch])
			}
			throw new Error("Checkpoint file exceeded 10 MiB during staging; retry after workspace writes finish")
		}
	}

	async tree(git: SimpleGit, ref: string) {
		const entries = splitGitPaths(await git.raw(["ls-tree", "-r", "-l", "-z", ref]))
		return entries.map((entry) => {
			const tab = entry.indexOf("\t")
			const [mode, type, , size] = entry.slice(0, tab).trim().split(/\s+/)
			return { file: entry.slice(tab + 1), mode, type, size: Number(size) }
		})
	}

	async prepareRestore(git: SimpleGit, commitHash: string) {
		// Resolve before any worktree mutation, and use the validated object ID below.
		const target = (await git.revparse(["--verify", "--end-of-options", `${commitHash}^{commit}`])).trim()
		const entries = await this.tree(git, target)
		const tracked = await this.list(git, "--cached")
		const ignoredTracked = await this.list(git, "--cached", "--ignored", "--exclude-standard")
		const ignored = new Set(await this.list(git, "--others", "--ignored", "--exclude-standard", "--directory"))
		const fail = () => {
			throw new Error(
				"Checkpoint restore blocked: it would touch an excluded, oversized (over 10 MiB), or unsafe file. " +
					"Workspace files were preserved. Use a newer source-only checkpoint or recover source files separately.",
			)
		}
		if (ignoredTracked.length) fail()
		for (const entry of entries) {
			const ancestors = entry.file.split("/")
			let prefix = ""
			const ignoredParent = ancestors.slice(0, -1).some((part) => {
				prefix += `${part}/`
				return ignored.has(prefix)
			})
			if (
				entry.type !== "blob" ||
				!entry.mode.startsWith("100") ||
				!Number.isFinite(entry.size) ||
				entry.size > MAX_CHECKPOINT_FILE_BYTES ||
				ignored.has(entry.file) ||
				ignoredParent
			)
				fail()
		}
		for (const file of new Set([...tracked, ...entries.map((entry) => entry.file)])) {
			if ((await this.inspect(file)) === "protected") fail()
		}
		// Never clean entire directories: that would remove unknown oversized files.
		const clean: string[] = []
		for (const file of await this.list(git, "--others", "--exclude-standard")) {
			if ((await this.inspect(file)) === "safe") clean.push(file)
		}
		return { target, clean }
	}
}
