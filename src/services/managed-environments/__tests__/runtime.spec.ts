import { EventEmitter } from "node:events"
import { Readable, PassThrough } from "node:stream"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import * as https from "node:https"
import { spawn } from "node:child_process"
import { cleanEnvironment, downloadWheel, runPython } from "../runtime"

vi.mock("node:https", () => ({ get: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

describe("managed runtime", () => {
	let base: string
	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "roo-download-test-"))
		vi.clearAllMocks()
	})
	afterEach(async () => fs.rm(base, { recursive: true, force: true }))

	function serve(bytes: Buffer, statusCode = 200, headers: Record<string, string> = {}) {
		vi.mocked(https.get).mockImplementation(((
			_url: unknown,
			_options: unknown,
			callback: (response: unknown) => void,
		) => {
			const response = Object.assign(Readable.from([bytes]), { statusCode, headers })
			const request = Object.assign(new EventEmitter(), { destroy: vi.fn() })
			queueMicrotask(() => callback(response))
			return request
		}) as unknown as typeof https.get)
	}

	it("verifies streamed hashes and sizes, with TLS and no redirect handling", async () => {
		const bytes = Buffer.from("wheel bytes")
		const pkg = {
			name: "demo",
			version: "1.0",
			url: "https://files.pythonhosted.org/packages/ab/cd/demo-1.0-py3-none-any.whl",
			sizeBytes: bytes.length,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		}
		serve(bytes)
		const target = path.join(base, "one.whl")
		await downloadWheel(pkg, target, new AbortController().signal)
		expect(await fs.readFile(target)).toEqual(bytes)
		expect(https.get).toHaveBeenCalledWith(
			pkg.url,
			expect.objectContaining({ rejectUnauthorized: true, agent: false }),
			expect.any(Function),
		)
		serve(bytes)
		await expect(
			downloadWheel({ ...pkg, sha256: "0".repeat(64) }, path.join(base, "two.whl"), new AbortController().signal),
		).rejects.toThrow("SHA-256")
		serve(bytes)
		await expect(
			downloadWheel({ ...pkg, sizeBytes: 1 }, path.join(base, "three.whl"), new AbortController().signal),
		).rejects.toThrow("exceeded")
		serve(bytes, 302, { location: "https://evil.test/" })
		await expect(downloadWheel(pkg, path.join(base, "four.whl"), new AbortController().signal)).rejects.toThrow(
			"redirect",
		)
		serve(bytes, 200, { "content-length": "999" })
		await expect(downloadWheel(pkg, path.join(base, "five.whl"), new AbortController().signal)).rejects.toThrow(
			"size",
		)
	})

	it("uses isolated argv without shell or inherited Python, pip, loader, or proxy variables", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const running = runPython("/trusted/python", ["-m", "venv", "/target"], base, new AbortController().signal)
		child.stdout.write("done")
		child.emit("close", 0)
		expect(await running).toBe("done")
		expect(spawn).toHaveBeenCalledWith(
			"/trusted/python",
			["-I", "-m", "venv", "/target"],
			expect.objectContaining({ shell: false, detached: true, env: cleanEnvironment(base) }),
		)
		expect(Object.keys(cleanEnvironment(base))).toEqual(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"])
	})

	it("kills the process group on cancellation and waits for close", async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: 123456789,
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: vi.fn(),
		})
		vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
		const kill = vi.spyOn(process, "kill").mockReturnValue(true)
		try {
			const controller = new AbortController()
			const running = runPython("/trusted/python", [], base, controller.signal)
			controller.abort()
			expect(kill).toHaveBeenCalledWith(-123456789, "SIGKILL")
			child.emit("close", null)
			await expect(running).rejects.toThrow("cancelled")
		} finally {
			kill.mockRestore()
		}
	})
})
