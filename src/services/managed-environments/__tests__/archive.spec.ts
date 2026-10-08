import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { INSPECT_WHEELS } from "../runtime"

// This invokes only trusted Python stdlib against synthetic ZIPs. It never installs or imports a wheel.
describe.skipIf(!existsSync("/usr/bin/python3"))("wheel ZIP inspection", () => {
	let base: string
	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "roo-wheel-inspection-"))
	})
	afterEach(async () => fs.rm(base, { recursive: true, force: true }))

	function inspect(name: string, contents: string, limit = 10000, symlink = false): string {
		const wheel = path.join(base, "demo.whl")
		execFileSync(
			"/usr/bin/python3",
			[
				"-I",
				"-S",
				"-c",
				`import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    info = zipfile.ZipInfo(sys.argv[2])
    if sys.argv[4] == 'yes':
        info.external_attr = 0o120777 << 16
    z.writestr(info, sys.argv[3])`,
				wheel,
				name,
				contents,
				symlink ? "yes" : "no",
			],
			{ stdio: "pipe" },
		)
		return execFileSync("/usr/bin/python3", ["-I", "-S", "-c", INSPECT_WHEELS, String(limit), wheel], {
			encoding: "utf8",
			stdio: "pipe",
		})
	}

	it("reads ordinary module bytes without executing them", () => {
		expect(JSON.parse(inspect("demo/__init__.py", "raise RuntimeError('do not execute')"))).toEqual({
			uncompressedBytes: 36,
		})
	})
	it.each([
		"../escape.py",
		"/absolute.py",
		"demo/../../escape.py",
		"demo\\escape.py",
		"demo.pth",
		"demo.data/scripts/evil",
		"pip/__init__.py",
		"sitecustomize.py",
		"usercustomize.cpython-311.so",
	])("rejects %s", (name) => {
		expect(() => inspect(name, "contents")).toThrow()
	})
	it("rejects symbolic links and uncompressed size overflow", () => {
		expect(() => inspect("demo/link", "target", 10000, true)).toThrow()
		expect(() => inspect("demo/module.py", "a".repeat(100), 10)).toThrow()
	})
	it.each(["../../outside", "python3.11", "pip", "activate"])("rejects unsafe generated script %s", (name) => {
		expect(() =>
			inspect("demo-1.0.dist-info/entry_points.txt", `[console_scripts]\n${name} = demo:main\n`),
		).toThrow()
	})
})
