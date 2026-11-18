import * as esbuild from "esbuild"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"
import process from "node:process"
import * as console from "node:console"

import { copyPaths, copyWasms, copyLocales, setupLocaleWatcher } from "@roo-code/build"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function removeDirWithRetries(dirPath, retries = 5, retryDelayMs = 200) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await fs.promises.rm(dirPath, { recursive: true, force: true })
			return
		} catch (error) {
			const isRetryable = error?.code === "ENOTEMPTY" || error?.code === "EBUSY" || error?.code === "EPERM"
			const isLastAttempt = attempt === retries

			if (!isRetryable || isLastAttempt) {
				throw error
			}

			await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelayMs * (attempt + 1)))
		}
	}
}

/**
 * Copy the prebuilt native desktop-control binaries into dist/native/ so one
 * universal VSIX works on macOS, Windows, and Linux. The extension loads them
 * by explicit path at runtime (see services/desktop/libnutLoader.ts).
 *
 * - libnut (3 platforms) is required: a missing binary fails the build.
 * - win32 also needs the MSVC runtime DLLs next to libnut.node, because Windows
 *   resolves a module's dependent DLLs from the module's own folder.
 * - permissions.node (macOS only) is optional: pnpm installs it only on macOS,
 *   so a VSIX built elsewhere warns and macOS permission checks fall back.
 */
function copyNativeBinaries(srcDir, distDir) {
	const nutRoot = path.join(srcDir, "node_modules", "@nut-tree-fork")
	const nativeDir = path.join(distDir, "native")

	for (const platform of ["darwin", "win32", "linux"]) {
		const releaseDir = path.join(nutRoot, `libnut-${platform}`, "build", "Release")
		const binary = path.join(releaseDir, "libnut.node")
		if (!fs.existsSync(binary)) {
			throw new Error(`[copyNativeBinaries] Missing ${binary}. Run pnpm install in src/.`)
		}

		const targetDir = path.join(nativeDir, "libnut", platform)
		fs.mkdirSync(targetDir, { recursive: true })

		const files = fs
			.readdirSync(releaseDir)
			.filter((f) => f === "libnut.node" || (platform === "win32" && f.toLowerCase().endsWith(".dll")))
		for (const file of files) {
			fs.copyFileSync(path.join(releaseDir, file), path.join(targetDir, file))
		}
		console.log(`[copyNativeBinaries] libnut ${platform}: ${files.length} file(s)`)
	}

	const permissions = path.join(nutRoot, "node-mac-permissions", "build", "Release", "permissions.node")
	if (fs.existsSync(permissions)) {
		const targetDir = path.join(nativeDir, "mac-permissions")
		fs.mkdirSync(targetDir, { recursive: true })
		fs.copyFileSync(permissions, path.join(targetDir, "permissions.node"))
		console.log("[copyNativeBinaries] mac-permissions: 1 file")
	} else {
		console.warn(
			"[copyNativeBinaries] WARNING: node-mac-permissions is not installed (it installs only on macOS). " +
				"The VSIX will not include permissions.node; macOS permission checks will show a warning instead.",
		)
	}
}

async function main() {
	const name = "extension"
	const production = process.argv.includes("--production")
	const watch = process.argv.includes("--watch")
	const minify = production
	const sourcemap = true // Always generate source maps for error handling.

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const buildOptions = {
		bundle: true,
		minify,
		sourcemap,
		logLevel: "silent",
		format: "cjs",
		sourcesContent: false,
		platform: "node",
	}

	const srcDir = __dirname
	const buildDir = __dirname
	const distDir = path.join(buildDir, "dist")

	if (fs.existsSync(distDir)) {
		console.log(`[${name}] Cleaning dist directory: ${distDir}`)
		await removeDirWithRetries(distDir)
	}

	/**
	 * @type {import('esbuild').Plugin[]}
	 */
	const plugins = [
		{
			name: "copyFiles",
			setup(build) {
				build.onEnd(() => {
					copyPaths(
						[
							["../README.md", "README.md"],
							["../CHANGELOG.md", "CHANGELOG.md"],
							["../LICENSE", "LICENSE"],
							["node_modules/vscode-material-icons/generated", "assets/vscode-material-icons"],
							["../webview-ui/audio", "webview-ui/audio"],
							["services/marketplace/bundled-mcps.yaml", "dist/bundled-mcps.yaml"],
						],
						srcDir,
						buildDir,
					)
				})
			},
		},
		{
			name: "copyWasms",
			setup(build) {
				build.onEnd(() => copyWasms(srcDir, distDir))
			},
		},
		{
			name: "copyLocales",
			setup(build) {
				build.onEnd(() => copyLocales(srcDir, distDir))
			},
		},
		{
			name: "copyNativeBinaries",
			setup(build) {
				build.onEnd(() => copyNativeBinaries(srcDir, distDir))
			},
		},
		{
			name: "esbuild-problem-matcher",
			setup(build) {
				build.onStart(() => console.log("[esbuild-problem-matcher#onStart]"))
				build.onEnd((result) => {
					result.errors.forEach(({ text, location }) => {
						console.error(`✘ [ERROR] ${text}`)
						if (location && location.file) {
							console.error(`    ${location.file}:${location.line}:${location.column}:`)
						}
					})

					console.log("[esbuild-problem-matcher#onEnd]")
				})
			},
		},
	]

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const extensionConfig = {
		...buildOptions,
		plugins,
		entryPoints: ["extension.ts"],
		outfile: "dist/extension.js",
		// global-agent must be external because it dynamically patches Node.js http/https modules
		// which breaks when bundled. It needs access to the actual Node.js module instances.
		// undici must be bundled because our VSIX is packaged with `--no-dependencies`.
		external: ["vscode", "esbuild", "global-agent"],
	}

	/**
	 * @type {import('esbuild').BuildOptions}
	 */
	const workerConfig = {
		...buildOptions,
		entryPoints: {
			countTokens: "workers/countTokens.ts",
			pdfExtraction: "integrations/misc/pdfExtraction.worker.ts",
		},
		outdir: "dist/workers",
	}

	const [extensionCtx, workerCtx] = await Promise.all([
		esbuild.context(extensionConfig),
		esbuild.context(workerConfig),
	])

	if (watch) {
		await Promise.all([extensionCtx.watch(), workerCtx.watch()])
		copyLocales(srcDir, distDir)
		setupLocaleWatcher(srcDir, distDir)
	} else {
		await Promise.all([extensionCtx.rebuild(), workerCtx.rebuild()])
		await Promise.all([extensionCtx.dispose(), workerCtx.dispose()])
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
