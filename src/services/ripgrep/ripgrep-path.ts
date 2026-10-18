import * as fs from "node:fs/promises"
import * as nodeFs from "node:fs"
import * as path from "node:path"

export class RipgrepNotFoundError extends Error {
	constructor() {
		super(
			"Could not find an executable ripgrep binary on the extension host. Repair the VS Code/code-server installation or install ripgrep on that host and restart the extension host.",
		)
		this.name = "RipgrepNotFoundError"
	}
}

/** Resolve on the extension host, never relative to the workspace or through a shell. */
export async function getBinPath(
	vscodeAppRoot: string,
	options: { execPath?: string; pathEnv?: string; platform?: NodeJS.Platform } = {},
): Promise<string | undefined> {
	const platform = options.platform ?? process.platform
	const bin = platform === "win32" ? "rg.exe" : "rg"
	const executableDir = path.dirname(options.execPath ?? process.execPath)
	const roots = [
		vscodeAppRoot,
		path.join(vscodeAppRoot, "lib/vscode"),
		executableDir,
		path.join(executableDir, "vscode"),
		path.dirname(executableDir),
	]
	const packages = [
		"node_modules/@vscode/ripgrep/bin",
		"node_modules/vscode-ripgrep/bin",
		"node_modules.asar.unpacked/@vscode/ripgrep/bin",
		"node_modules.asar.unpacked/vscode-ripgrep/bin",
	]
	const candidates = roots
		.filter((root) => path.isAbsolute(root))
		.flatMap((root) => packages.map((pkg) => path.join(root, pkg, bin)))
	for (const directory of (options.pathEnv ?? process.env.PATH ?? "").split(path.delimiter)) {
		// Empty/relative PATH entries would execute workspace-controlled programs.
		if (path.isAbsolute(directory)) candidates.push(path.join(directory, bin))
	}
	for (const candidate of new Set(candidates)) {
		try {
			if (!(await fs.stat(candidate)).isFile()) continue
			await fs.access(candidate, platform === "win32" ? nodeFs.constants.F_OK : nodeFs.constants.X_OK)
			return candidate
		} catch {
			/* Missing or not executable; try the next installed candidate. */
		}
	}
	return undefined
}
