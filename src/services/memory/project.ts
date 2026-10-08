import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { devNull } from "node:os"
import { promisify } from "node:util"
import type { MemoryProject } from "./types"

const execFileAsync = promisify(execFile)

/** Local identity only. No remotes, hooks, shell, repository configuration, or network operations. */
export async function resolveMemoryProject(cwd: string): Promise<MemoryProject> {
	const rootPath = await fs.realpath(cwd)
	if (!(await fs.stat(rootPath)).isDirectory()) throw new Error("Memory project must be a directory")
	let identity = `folder:${rootPath}`
	let label = path.basename(rootPath) || rootPath
	// Drop every inherited Git override, including GIT_CONFIG_COUNT and GIT_DIR.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")))
	Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" })
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: rootPath,
			env,
			timeout: 3000,
			maxBuffer: 16 * 1024,
			windowsHide: true,
		})
		const commonDir = await fs.realpath(stdout.trim())
		if (!(await fs.stat(commonDir)).isDirectory()) throw new Error("Invalid Git common directory")
		identity = `git:${commonDir}`
		label = path.basename(commonDir) === ".git" ? path.basename(path.dirname(commonDir)) : path.basename(commonDir)
	} catch {
		// The selected folder is the fallback, never an inferred home/ancestor folder.
	}
	return { key: createHash("sha256").update(`roo-memory-v1\0${identity}`).digest("hex"), label, rootPath }
}
