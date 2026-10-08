import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
	installEnvironment,
	inspectEnvironments,
	parseManifest,
	prepareEnvironment,
	type ManagedEnvironmentPolicy,
} from "../index"
import { downloadWheel, runPython, INSPECT_WHEELS, PROBE_PYTHON } from "../runtime"

vi.mock("../runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("../runtime")>()),
	runPython: vi.fn(),
	downloadWheel: vi.fn(),
}))

const manifest = () => ({
	version: 1,
	pythonVersion: "3.11",
	packages: [
		{
			name: "demo",
			version: "1.0",
			url: "https://files.pythonhosted.org/packages/ab/cd/demo-1.0-py3-none-any.whl",
			sha256: "a".repeat(64),
			sizeBytes: 10,
		},
	],
})

describe("managed Python manifest", () => {
	it("accepts bounded exact wheel manifests", () => {
		expect(parseManifest(manifest()).packages).toHaveLength(1)
	})
	it.each([
		"http://files.pythonhosted.org/packages/ab/cd/demo-1.0-py3-none-any.whl",
		"https://files.pythonhosted.org.evil.test/packages/ab/cd/demo-1.0-py3-none-any.whl",
		"https://user@files.pythonhosted.org/packages/ab/cd/demo-1.0-py3-none-any.whl",
		"https://files.pythonhosted.org/packages/ab/../demo-1.0-py3-none-any.whl",
		"https://files.pythonhosted.org/packages/ab/%2e%2e/demo-1.0-py3-none-any.whl",
		"https://files.pythonhosted.org/packages/ab/cd/demo-1.0-py3-none-any.whl?download=1",
		"https://files.pythonhosted.org/packages/ab/cd/demo-1.0.tar.gz",
		"https://files.pythonhosted.org/packages/ab/cd/other-1.0-py3-none-any.whl",
	])("rejects unsafe wheel URL %s", (url) => {
		const input = manifest()
		input.packages[0].url = url
		expect(() => parseManifest(input)).toThrow()
	})
	it("rejects unknown fields, bad hashes, sizes, duplicate names, and oversized lists", () => {
		expect(() => parseManifest({ ...manifest(), command: "sh" })).toThrow()
		for (const change of [{ sha256: "no" }, { sizeBytes: -1 }, { version: "1.0;sh" }, { name: "pip" }]) {
			expect(() =>
				parseManifest({ ...manifest(), packages: [{ ...manifest().packages[0], ...change }] }),
			).toThrow()
		}
		expect(() => parseManifest({ ...manifest(), packages: Array(101).fill(manifest().packages[0]) })).toThrow()
		expect(() => parseManifest({ ...manifest(), packages: Array(2).fill(manifest().packages[0]) })).toThrow()
	})
})

describe.skipIf(process.platform !== "linux")("managed Python service", () => {
	let base: string
	let workspaceDir: string
	let manifestPath: string
	let policy: ManagedEnvironmentPolicy
	beforeEach(async () => {
		// /tmp is intentionally forbidden for managed roots: its ancestor is world writable.
		base = await fs.mkdtemp(path.join(os.homedir(), ".roo-managed-test-"))
		workspaceDir = path.join(base, "workspace")
		await fs.mkdir(workspaceDir, { mode: 0o700 })
		manifestPath = path.join(workspaceDir, "environment.json")
		await fs.writeFile(manifestPath, JSON.stringify(manifest()))
		const pythonPath = path.join(base, "python")
		await fs.writeFile(pythonPath, "test executable, never run", { mode: 0o700 })
		policy = {
			root: path.join(base, "managed"),
			pythonPath,
			maxDownloadBytes: 1024,
			maxDiskBytes: 10 * 1024 * 1024,
			timeoutMs: 1000,
		}
		vi.mocked(runPython).mockReset()
		vi.mocked(downloadWheel).mockReset()
		vi.mocked(runPython).mockImplementation(async (_python, args) => {
			if (args.includes(PROBE_PYTHON)) return '{"version":"3.11.9","implementation":"cpython"}'
			if (args.includes("venv")) {
				const destination = args.at(-1)!
				await fs.mkdir(path.join(destination, "bin"), { recursive: true, mode: 0o700 })
				await fs.writeFile(path.join(destination, "bin", "python"), "fake", { mode: 0o700 })
				return ""
			}
			if (args.includes(INSPECT_WHEELS)) return '{"uncompressedBytes":20}'
			return ""
		})
		vi.mocked(downloadWheel).mockImplementation(async (_pkg, destination) => {
			await fs.writeFile(destination, "fake wheel")
		})
	})
	afterEach(async () => {
		await fs.rm(base, { recursive: true, force: true })
	})
	const prepare = () => prepareEnvironment({ workspaceDir, manifestPath, policy })

	it("prepares without writes, network, or processes and binds executable bytes", async () => {
		const first = await prepare()
		expect(first.interpreterPath).toBe(path.join(policy.root, first.fingerprint, "venv", "bin", "python"))
		expect(first.totalDownloadBytes).toBe(10)
		expect(await fs.readdir(base)).toEqual(expect.arrayContaining(["workspace", "python"]))
		await expect(fs.stat(policy.root)).rejects.toMatchObject({ code: "ENOENT" })
		expect(runPython).not.toHaveBeenCalled()
		expect(downloadWheel).not.toHaveBeenCalled()
		await fs.appendFile(policy.pythonPath, "changed")
		expect((await prepare()).fingerprint).not.toBe(first.fingerprint)
	})

	it("rejects outside manifests, workspace roots, symlinks, insecure roots, and budgets", async () => {
		await expect(prepareEnvironment({ workspaceDir, manifestPath: "../python", policy })).rejects.toThrow("inside")
		await expect(
			prepareEnvironment({
				workspaceDir,
				manifestPath,
				policy: { ...policy, root: path.join(workspaceDir, "env") },
			}),
		).rejects.toThrow("separate")
		const link = path.join(workspaceDir, "link.json")
		await fs.symlink(manifestPath, link)
		await expect(prepareEnvironment({ workspaceDir, manifestPath: link, policy })).rejects.toThrow("Symbolic")
		const interpreterLink = path.join(base, "python-link")
		await fs.symlink(policy.pythonPath, interpreterLink)
		await expect(
			prepareEnvironment({ workspaceDir, manifestPath, policy: { ...policy, pythonPath: interpreterLink } }),
		).rejects.toThrow("Symbolic")
		await expect(
			prepareEnvironment({ workspaceDir, manifestPath, policy: { ...policy, maxDownloadBytes: 1 } }),
		).rejects.toThrow("budget")
		await fs.mkdir(policy.root, { mode: 0o777 })
		await fs.chmod(policy.root, 0o777)
		await expect(prepare()).rejects.toThrow("Insecure")
	})

	it.each(["manifest", "interpreter", "plan", "clone"])("rejects approval mutation of %s", async (what) => {
		let plan = await prepare()
		if (what === "manifest") await fs.appendFile(manifestPath, " ")
		if (what === "interpreter") await fs.appendFile(policy.pythonPath, "changed")
		if (what === "plan") plan.policy.maxDownloadBytes++
		if (what === "clone") plan = structuredClone(plan)
		await expect(installEnvironment(plan, { taskId: "task" })).rejects.toThrow(/changed|not prepared/)
		expect(runPython).not.toHaveBeenCalled()
	})

	it("publishes only successful installs, refuses reuse, and reports checkpoint mismatch read-only", async () => {
		const plan = await prepare()
		const result = await installEnvironment(plan, { taskId: "task" })
		expect(result.status).toBe("ready")
		expect(result.pythonVersion).toBe("3.11.9")
		const calls = vi.mocked(runPython).mock.calls
		expect(
			calls.some(
				([, args]) =>
					args.includes("--no-index") && args.includes("--no-deps") && args.includes("--only-binary=:all:"),
			),
		).toBe(true)
		expect(calls.some(([, args]) => args.includes("check"))).toBe(true)
		await expect(installEnvironment(plan, { taskId: "task" })).rejects.toThrow("already exists")
		vi.mocked(runPython).mockClear()
		expect((await inspectEnvironments({ workspaceDir, manifestPath, policy })).selected?.fingerprint).toBe(
			plan.fingerprint,
		)
		await fs.appendFile(manifestPath, " ")
		expect((await inspectEnvironments({ workspaceDir, manifestPath, policy })).manifestMismatch).toBe(true)
		await fs.unlink(manifestPath)
		const missing = await inspectEnvironments({ workspaceDir, manifestPath, policy })
		expect(missing.manifestMismatch).toBe(true)
		expect(missing.manifestError).toBeDefined()
		expect(missing.environments).toHaveLength(1)
		expect(runPython).not.toHaveBeenCalled()
	})

	it("keeps failed staging incomplete and never adopts existing user material", async () => {
		const plan = await prepare()
		vi.mocked(downloadWheel).mockRejectedValue(new Error("hash mismatch"))
		await expect(installEnvironment(plan, { taskId: "task" })).rejects.toThrow("hash mismatch")
		const status = await inspectEnvironments({ workspaceDir, policy })
		expect(status.environments).toEqual([])
		expect(status.incompleteCount).toBe(1)
		await expect(fs.stat(path.dirname(plan.environmentPath))).rejects.toMatchObject({ code: "ENOENT" })
		const userRoot = path.join(base, "user-root")
		await fs.mkdir(userRoot, { mode: 0o700 })
		await fs.writeFile(path.join(userRoot, "keep"), "user material")
		const userPlan = await prepareEnvironment({ workspaceDir, manifestPath, policy: { ...policy, root: userRoot } })
		await expect(installEnvironment(userPlan, { taskId: "task" })).rejects.toThrow("adopt")
		expect(await fs.readFile(path.join(userRoot, "keep"), "utf8")).toBe("user material")
	})

	it("honors cancellation before mutation and after a running phase", async () => {
		const plan = await prepare()
		const controller = new AbortController()
		controller.abort()
		await expect(installEnvironment(plan, { taskId: "task", signal: controller.signal })).rejects.toThrow(
			"cancelled",
		)
		expect(runPython).not.toHaveBeenCalled()
		const running = new AbortController()
		vi.mocked(downloadWheel).mockImplementation(async () => running.abort())
		await expect(installEnvironment(plan, { taskId: "task", signal: running.signal })).rejects.toThrow("cancelled")
		expect((await inspectEnvironments({ workspaceDir, policy })).environments).toHaveLength(0)
	})

	it("rejects oversized manifests and symlink ancestors", async () => {
		await fs.writeFile(manifestPath, " ".repeat(256 * 1024 + 1))
		await expect(prepare()).rejects.toThrow("oversized")
		const linkedWorkspace = path.join(base, "linked-workspace")
		await fs.symlink(workspaceDir, linkedWorkspace)
		await expect(
			prepareEnvironment({ workspaceDir: linkedWorkspace, manifestPath: "environment.json", policy }),
		).rejects.toThrow("Symbolic")
	})
})
