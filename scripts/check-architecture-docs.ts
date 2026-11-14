/**
 * Validates docs/architecture/ against docs/architecture/RECORD-FORMAT.md.
 *
 * Usage:
 *   pnpm check:architecture [-- --root <dir>] [--approval user|agent]
 *
 * Exit code 1 on errors, 0 otherwise (warnings are printed).
 */
import * as path from "path"

import { type ApprovalPolicy, checkArchitectureDocs, formatIssue } from "../src/shared/architecture-docs/check"

function parseArgs(argv: string[]): { root: string; approval: ApprovalPolicy } {
	let root = "docs/architecture"
	let approval: ApprovalPolicy = "user"
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === "--") continue
		if (arg === "--root" && argv[i + 1]) {
			root = argv[++i]
		} else if (arg === "--approval" && argv[i + 1]) {
			const value = argv[++i]
			if (value !== "user" && value !== "agent") {
				throw new Error(`--approval must be "user" or "agent", got "${value}"`)
			}
			approval = value
		} else {
			throw new Error(`Unknown argument: ${arg}`)
		}
	}
	return { root, approval }
}

async function main() {
	const { root, approval } = parseArgs(process.argv.slice(2))
	const result = await checkArchitectureDocs(path.resolve(root), { approval })
	for (const issue of result.issues) {
		console.log(formatIssue(issue))
	}
	console.log(
		`Checked ${result.records.length} records in ${root} (approval: ${approval}): ${result.errorCount} errors, ${result.warningCount} warnings`,
	)
	process.exitCode = result.errorCount > 0 ? 1 : 0
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err))
	process.exitCode = 1
})
