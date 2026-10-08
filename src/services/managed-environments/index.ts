import * as fs from "node:fs/promises"
import * as path from "node:path"
import { z } from "zod"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { MAX_MANIFEST_BYTES, parseManifest, wheelFilename, type Manifest } from "./manifest"
import { boundedRead, digest, directoryBytes, exists, hashExecutable, isWithin, validatePath } from "./paths"
import { checkAbort, downloadWheel, INSPECT_WHEELS, PROBE_PYTHON, RUN_PIP, runPython } from "./runtime"

export { manifestSchema, parseManifest } from "./manifest"
export type { Manifest } from "./manifest"

export type ManagedEnvironmentPolicy = {
	root: string
	pythonPath: string
	maxDownloadBytes: number
	maxDiskBytes: number
	timeoutMs: number
}

export type ManagedEnvironmentPlan = {
	workspaceDir: string
	manifestPath: string
	manifest: Manifest
	manifestSha256: string
	policy: ManagedEnvironmentPolicy
	fingerprint: string
	environmentPath: string
	interpreterPath: string
	pythonExecutableSha256: string
	platform: string
	arch: string
	totalDownloadBytes: number
}

export type ManagedEnvironmentResult = {
	fingerprint: string
	runtimeFingerprint: string
	environmentPath: string
	interpreterPath: string
	pythonVersion: string
	status: "ready"
	manifestSha256: string
	createdAt: string
}

export type ManagedEnvironmentInventory = {
	environments: ManagedEnvironmentResult[]
	manifestPaths: string[]
	selected: ManagedEnvironmentResult | null
	manifestMismatch: boolean
	manifestError?: string
	incompleteCount: number
	invalidCount: number
}

const policySchema = z
	.object({
		root: z.string().min(1),
		pythonPath: z.string().min(1),
		maxDownloadBytes: z
			.number()
			.int()
			.positive()
			.max(2 * 1024 ** 3),
		maxDiskBytes: z
			.number()
			.int()
			.positive()
			.max(20 * 1024 ** 3),
		timeoutMs: z
			.number()
			.int()
			.min(1000)
			.max(60 * 60 * 1000),
	})
	.strict()

const resultSchema = z
	.object({
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
		runtimeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
		environmentPath: z.string(),
		interpreterPath: z.string(),
		pythonVersion: z.string().regex(/^3\.\d+\.\d+$/),
		status: z.literal("ready"),
		manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
		createdAt: z.string().datetime(),
	})
	.strict()

const recordSchema = z
	.object({
		version: z.literal(1),
		owner: z.literal("roo-managed-python-v1"),
		workspaceDir: z.string(),
		manifestPath: z.string(),
		taskId: z.string().min(1).max(200),
		manifest: z.unknown().transform(parseManifest),
		result: resultSchema,
	})
	.strict()

// Approval capabilities stay in process. Serialized or edited plans are never executable.
const approvedPlans = new WeakMap<ManagedEnvironmentPlan, string>()

async function validatePolicy(
	workspaceDir: string,
	input: ManagedEnvironmentPolicy,
): Promise<ManagedEnvironmentPolicy> {
	if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch) || !process.getuid) {
		throw new Error("Managed Python MVP supports Linux x64/arm64 only")
	}
	const policy = policySchema.parse(input)
	await validatePath(workspaceDir)
	if (!(await fs.lstat(workspaceDir)).isDirectory()) throw new Error("Workspace must be a directory")
	for (const filename of [policy.root, policy.pythonPath]) {
		if (!path.isAbsolute(filename) || isWithin(workspaceDir, filename) || isWithin(filename, workspaceDir)) {
			throw new Error("Managed root and configured interpreter must be absolute and separate from the workspace")
		}
		await validatePath(filename, true, filename === policy.root)
	}
	if (isWithin(policy.root, policy.pythonPath))
		throw new Error("Configured interpreter must be outside the managed root")
	if (!(await exists(policy.root))) await validatePath(path.dirname(policy.root), true)
	if (await exists(policy.root)) {
		const info = await fs.lstat(policy.root)
		if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) {
			throw new Error("Existing managed root must be a private directory owned by the current user")
		}
	}
	return policy
}

export async function prepareEnvironment({
	workspaceDir,
	manifestPath,
	policy: input,
}: {
	workspaceDir: string
	manifestPath: string
	policy: ManagedEnvironmentPolicy
}): Promise<ManagedEnvironmentPlan> {
	workspaceDir = path.resolve(workspaceDir)
	const policy = await validatePolicy(workspaceDir, input)
	manifestPath = path.resolve(workspaceDir, manifestPath)
	if (!isWithin(workspaceDir, manifestPath) || manifestPath === workspaceDir)
		throw new Error("Manifest must be inside the workspace")
	await validatePath(manifestPath)
	const raw = await boundedRead(manifestPath, MAX_MANIFEST_BYTES)
	const manifest = parseManifest(JSON.parse(raw.toString("utf8")))
	const totalDownloadBytes = manifest.packages.reduce((total, pkg) => total + pkg.sizeBytes, 0)
	if (
		!Number.isSafeInteger(totalDownloadBytes) ||
		totalDownloadBytes > policy.maxDownloadBytes ||
		totalDownloadBytes > policy.maxDiskBytes
	) {
		throw new Error("Manifest exceeds the download or disk budget")
	}
	const pythonExecutableSha256 = await hashExecutable(policy.pythonPath)
	const manifestSha256 = digest(raw)
	const fingerprint = digest(
		JSON.stringify({
			version: 1,
			manifest,
			manifestSha256,
			pythonPath: policy.pythonPath,
			pythonExecutableSha256,
			platform: process.platform,
			arch: process.arch,
			workspaceDir,
			manifestPath,
		}),
	)
	const environmentPath = path.join(policy.root, fingerprint, "venv")
	const plan: ManagedEnvironmentPlan = {
		workspaceDir,
		manifestPath,
		manifest,
		manifestSha256,
		policy,
		fingerprint,
		environmentPath,
		interpreterPath: path.join(environmentPath, "bin", "python"),
		pythonExecutableSha256,
		platform: process.platform,
		arch: process.arch,
		totalDownloadBytes,
	}
	approvedPlans.set(plan, JSON.stringify(plan))
	return plan
}

async function revalidate(plan: ManagedEnvironmentPlan): Promise<void> {
	const original = approvedPlans.get(plan)
	if (!original || original !== JSON.stringify(plan))
		throw new Error("Plan was not prepared here or changed after preparation")
	const current = await prepareEnvironment(plan)
	if (JSON.stringify(current) !== original)
		throw new Error("Manifest, policy, or interpreter changed after approval; prepare and approve again")
}

async function ensureRoot(root: string): Promise<void> {
	if (!(await exists(root))) {
		// Parent must already exist; never recursively create a chain of unmanaged directories.
		await validatePath(path.dirname(root), true)
		try {
			await fs.mkdir(root, { mode: 0o700 })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		}
	}
	await validatePath(root, true)
	const info = await fs.lstat(root)
	if (!info.isDirectory() || info.uid !== process.getuid!() || info.mode & 0o077)
		throw new Error("Managed root is not private")
	const marker = path.join(root, "owner.json")
	if (!(await exists(marker))) {
		if ((await fs.readdir(root)).length) throw new Error("Refusing to adopt a nonempty unmanaged root")
		await safeWriteJson(marker, { owner: "roo-managed-python-v1", version: 1 })
	} else {
		await validatePath(marker, true)
		const owner = JSON.parse((await boundedRead(marker, 1024)).toString("utf8"))
		if (owner.owner !== "roo-managed-python-v1" || owner.version !== 1) throw new Error("Unrecognized managed root")
	}
}

/** No existing environment is reused or modified. Approval must be handled by the caller. */
export async function installEnvironment(
	plan: ManagedEnvironmentPlan,
	{
		taskId,
		signal,
	}: {
		taskId: string
		signal?: AbortSignal
	},
): Promise<ManagedEnvironmentResult> {
	if (!taskId || taskId.length > 200) throw new Error("A bounded task ID is required")
	const controller = new AbortController()
	const abort = () => controller.abort()
	signal?.addEventListener("abort", abort, { once: true })
	if (signal?.aborted) controller.abort()
	const timer = setTimeout(abort, plan.policy.timeoutMs)
	const activeSignal = controller.signal
	let lock: string | undefined
	let staging: string | undefined
	try {
		checkAbort(activeSignal)
		await revalidate(plan)
		checkAbort(activeSignal)
		await ensureRoot(plan.policy.root)
		const target = path.dirname(plan.environmentPath)
		const lockPath = path.join(plan.policy.root, `.lock-${plan.fingerprint}`)
		await fs.mkdir(lockPath, { mode: 0o700 })
		lock = lockPath
		if (await exists(target))
			throw new Error("Managed environment already exists; existing environments are never modified or reused")
		await revalidate(plan)
		checkAbort(activeSignal)
		staging = await fs.mkdtemp(path.join(plan.policy.root, `.pending-${plan.fingerprint}-`))
		const version = z
			.object({ version: z.string().regex(/^3\.\d+\.\d+$/), implementation: z.literal("cpython") })
			.strict()
			.parse(JSON.parse(await runPython(plan.policy.pythonPath, ["-c", PROBE_PYTHON], staging, activeSignal)))
		if (version.version.split(".").slice(0, 2).join(".") !== plan.manifest.pythonVersion)
			throw new Error("Configured Python version does not match manifest")
		const stageVenv = path.join(staging, "venv")
		await runPython(plan.policy.pythonPath, ["-m", "venv", "--copies", stageVenv], staging, activeSignal)
		// CPython creates this harmless convenience link even with --copies on some Linux builds.
		const lib64 = path.join(stageVenv, "lib64")
		if (await exists(lib64)) {
			if (!(await fs.lstat(lib64)).isSymbolicLink() || (await fs.readlink(lib64)) !== "lib")
				throw new Error("Unexpected venv lib64 entry")
			await fs.unlink(lib64)
		}
		const initialBytes = await directoryBytes(staging, plan.policy.maxDiskBytes)
		if (initialBytes + plan.totalDownloadBytes > plan.policy.maxDiskBytes)
			throw new Error("Insufficient disk budget for downloads")
		const downloads = path.join(staging, "downloads")
		await fs.mkdir(downloads, { mode: 0o700 })
		const wheels: string[] = []
		for (const pkg of plan.manifest.packages) {
			checkAbort(activeSignal)
			const destination = path.join(downloads, wheelFilename(pkg.url))
			await downloadWheel(pkg, destination, activeSignal)
			wheels.push(destination)
		}
		checkAbort(activeSignal)
		const inspection = z
			.object({ uncompressedBytes: z.number().int().nonnegative() })
			.strict()
			.parse(
				JSON.parse(
					await runPython(
						plan.policy.pythonPath,
						[
							"-S",
							"-c",
							INSPECT_WHEELS,
							String(plan.policy.maxDiskBytes - initialBytes - plan.totalDownloadBytes),
							...wheels,
						],
						staging,
						activeSignal,
					),
				),
			)
		// Pip can temporarily retain a second extraction copy. This is conservative accounting, not a quota.
		if (initialBytes + plan.totalDownloadBytes + inspection.uncompressedBytes * 2 > plan.policy.maxDiskBytes)
			throw new Error("Insufficient disk budget for wheel extraction")
		const stagePython = path.join(stageVenv, "bin", "python")
		await validatePath(stagePython, true)
		const site = path.join(stageVenv, "lib", `python${plan.manifest.pythonVersion}`, "site-packages")
		const pip = [
			"-S",
			"-c",
			RUN_PIP,
			site,
			stageVenv,
			plan.interpreterPath,
			"--isolated",
			"--disable-pip-version-check",
		]
		await runPython(
			stagePython,
			[
				...pip,
				"install",
				"--no-index",
				"--no-deps",
				"--only-binary=:all:",
				"--no-cache-dir",
				"--no-compile",
				...wheels,
			],
			staging,
			activeSignal,
		)
		await runPython(stagePython, [...pip, "check"], staging, activeSignal)
		await directoryBytes(staging, plan.policy.maxDiskBytes)
		checkAbort(activeSignal)
		// Activation scripts embed the temporary location. Explicit interpreter use is the only supported interface.
		for (const filename of await fs.readdir(path.join(stageVenv, "bin"))) {
			if (/^activate(?:\.|$)/i.test(filename)) await fs.unlink(path.join(stageVenv, "bin", filename))
		}
		await fs.rm(downloads, { recursive: true })
		await revalidate(plan)
		checkAbort(activeSignal)
		const result: ManagedEnvironmentResult = {
			fingerprint: plan.fingerprint,
			runtimeFingerprint: digest(JSON.stringify({ fingerprint: plan.fingerprint, ...version })),
			environmentPath: plan.environmentPath,
			interpreterPath: plan.interpreterPath,
			pythonVersion: version.version,
			status: "ready",
			manifestSha256: plan.manifestSha256,
			createdAt: new Date().toISOString(),
		}
		await safeWriteJson(path.join(staging, "record.json"), {
			version: 1,
			owner: "roo-managed-python-v1",
			workspaceDir: plan.workspaceDir,
			manifestPath: plan.manifestPath,
			taskId,
			manifest: plan.manifest,
			result,
		})
		await directoryBytes(staging, plan.policy.maxDiskBytes)
		checkAbort(activeSignal)
		if (await exists(target)) throw new Error("Managed environment target collision")
		await fs.rename(staging, target)
		staging = undefined
		return result
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", abort)
		// Leave failed staging material for explicit user cleanup. Never recursively delete on a failure.
		if (lock) await fs.rmdir(lock).catch(() => undefined)
	}
}

export async function inspectEnvironments({
	workspaceDir,
	manifestPath,
	policy: input,
}: {
	workspaceDir: string
	manifestPath?: string
	policy: ManagedEnvironmentPolicy
}): Promise<ManagedEnvironmentInventory> {
	workspaceDir = path.resolve(workspaceDir)
	const policy = await validatePolicy(workspaceDir, input)
	const inventory: ManagedEnvironmentInventory = {
		environments: [],
		manifestPaths: [],
		selected: null,
		manifestMismatch: false,
		incompleteCount: 0,
		invalidCount: 0,
	}
	let plan: ManagedEnvironmentPlan | undefined
	if (manifestPath !== undefined) {
		try {
			plan = await prepareEnvironment({ workspaceDir, manifestPath, policy })
		} catch (error) {
			inventory.manifestMismatch = true
			inventory.manifestError = String(error).slice(0, 1024)
		}
	}
	if (!(await exists(policy.root))) return inventory
	const entries = await fs.readdir(policy.root, { withFileTypes: true })
	if (entries.length > 1000) throw new Error("Managed inventory exceeds the bounded entry limit")
	for (const entry of entries) {
		if (entry.name.startsWith(".pending-") || entry.name.startsWith(".lock-")) {
			inventory.incompleteCount++
			continue
		}
		if (!/^[a-f0-9]{64}$/.test(entry.name)) continue
		try {
			const directory = path.join(policy.root, entry.name)
			const filename = path.join(directory, "record.json")
			await validatePath(filename, true)
			const record = recordSchema.parse(
				JSON.parse((await boundedRead(filename, MAX_MANIFEST_BYTES)).toString("utf8")),
			)
			if (
				record.result.fingerprint !== entry.name ||
				record.result.environmentPath !== path.join(directory, "venv") ||
				record.result.interpreterPath !== path.join(directory, "venv", "bin", "python")
			)
				throw new Error("Inventory path mismatch")
			await validatePath(record.result.interpreterPath, true)
			if (record.workspaceDir !== workspaceDir) continue
			inventory.environments.push(record.result)
			if (!inventory.manifestPaths.includes(record.manifestPath))
				inventory.manifestPaths.push(record.manifestPath)
			if (plan && record.manifestPath === plan.manifestPath) {
				if (record.result.fingerprint === plan.fingerprint) inventory.selected = record.result
				else inventory.manifestMismatch = true
			}
		} catch {
			inventory.invalidCount++
		}
	}
	if (inventory.selected) inventory.manifestMismatch = false
	inventory.environments.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
	return inventory
}
