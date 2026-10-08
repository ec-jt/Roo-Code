import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as https from "node:https"
import type { Manifest } from "./manifest"

export function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("Managed environment installation cancelled or timed out")
}

/** An allowlist, not a copy of the extension process environment. */
export function cleanEnvironment(home: string): NodeJS.ProcessEnv {
	return {
		PATH: "/usr/bin:/bin",
		HOME: home,
		TMPDIR: home,
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
	}
}

export async function runPython(executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
	checkAbort(signal)
	return new Promise((resolve, reject) => {
		const child = spawn(executable, ["-I", ...args], {
			cwd,
			env: cleanEnvironment(cwd),
			shell: false,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let output = ""
		let failure: Error | undefined
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL")
			} catch {
				child.kill("SIGKILL")
			}
		}
		const abort = () => {
			failure = new Error("Managed environment installation cancelled or timed out")
			kill()
		}
		const collect = (chunk: Buffer) => {
			if (Buffer.byteLength(output) + chunk.length > 64 * 1024) {
				failure = new Error("Python output exceeded the safety limit")
				kill()
			} else output += chunk.toString("utf8")
		}
		child.stdout.on("data", collect)
		child.stderr.on("data", collect)
		signal.addEventListener("abort", abort, { once: true })
		if (signal.aborted) abort()
		child.once("error", (error) => {
			signal.removeEventListener("abort", abort)
			reject(error)
		})
		child.once("close", (code) => {
			signal.removeEventListener("abort", abort)
			if (failure) reject(failure)
			else if (code !== 0)
				reject(new Error(`Isolated Python operation failed (${code}): ${output.slice(0, 4096)}`))
			else resolve(output.trim())
		})
	})
}

export async function downloadWheel(
	pkg: Manifest["packages"][number],
	destination: string,
	signal: AbortSignal,
): Promise<void> {
	checkAbort(signal)
	const file = await fs.open(destination, "wx", 0o600)
	try {
		await new Promise<void>((resolve, reject) => {
			const request = https.get(
				pkg.url,
				{
					signal,
					rejectUnauthorized: true,
					agent: false,
					headers: { "Accept-Encoding": "identity" },
				},
				(response) => {
					void (async () => {
						if (
							response.statusCode !== 200 ||
							response.headers["content-encoding"] ||
							(response.headers["content-length"] !== undefined &&
								response.headers["content-length"] !== String(pkg.sizeBytes))
						) {
							throw new Error("Wheel download rejected: status, redirect, encoding, or size mismatch")
						}
						const hash = createHash("sha256")
						let size = 0
						for await (const chunk of response) {
							checkAbort(signal)
							const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
							size += bytes.length
							if (size > pkg.sizeBytes) throw new Error("Wheel download exceeded declared size")
							hash.update(bytes)
							let offset = 0
							while (offset < bytes.length)
								offset += (await file.write(bytes, offset, bytes.length - offset)).bytesWritten
						}
						if (size !== pkg.sizeBytes || hash.digest("hex") !== pkg.sha256) {
							throw new Error("Wheel download size or SHA-256 mismatch")
						}
					})().then(resolve, (error) => {
						response.destroy()
						request.destroy()
						reject(error)
					})
				},
			)
			request.once("error", reject)
		})
	} finally {
		await file.close()
	}
}

export const PROBE_PYTHON = `import json, platform, sys
assert sys.implementation.name == 'cpython', 'Only CPython is supported'
assert sys.prefix == sys.base_prefix, 'Configured Python must not be an existing virtual environment'
print(json.dumps({'version': platform.python_version(), 'implementation': sys.implementation.name}))`

/** Inspect and fully decompress archives with trusted stdlib, without extracting/importing them. */
export const INSPECT_WHEELS = `import configparser, json, pathlib, re, stat, sys, zipfile
limit = int(sys.argv[1])
total = 0
entries = 0
for filename in sys.argv[2:]:
    with zipfile.ZipFile(filename) as archive:
        seen = set()
        for item in archive.infolist():
            entries += 1
            assert entries <= 100000, 'Too many wheel entries'
            name = item.filename
            parts = pathlib.PurePosixPath(name).parts
            assert name and not name.startswith('/') and '\\\\' not in name and ':' not in name, 'Unsafe wheel path'
            assert all(p not in ('', '.', '..') for p in name.rstrip('/').split('/')), 'Unsafe wheel path'
            assert name not in seen, 'Duplicate wheel entry'
            seen.add(name)
            mode = item.external_attr >> 16
            assert stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), 'Special wheel entry'
            assert not item.flag_bits & 1, 'Encrypted wheel entry'
            assert item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), 'Unsupported compression'
            assert not any(p.lower().endswith(('.pth', '.data')) for p in parts), 'Wheel startup hooks and relocation are unsupported'
            top = parts[0].lower()
            assert top not in ('pip', 'setuptools', 'wheel', '_distutils_hack', 'sitecustomize.py', 'usercustomize.py', 'sitecustomize', 'usercustomize'), 'Installer or startup replacement'
            assert not top.startswith(('pip.', 'setuptools.', 'wheel.', 'sitecustomize.', 'usercustomize.')), 'Installer replacement'
            if name.endswith('.dist-info/entry_points.txt'):
                assert item.file_size <= 65536, 'Oversized entry point metadata'
                config = configparser.ConfigParser(interpolation=None)
                config.read_string(archive.read(item).decode('utf-8'))
                for section in ('console_scripts', 'gui_scripts'):
                    if config.has_section(section):
                        for script in config[section]:
                            assert re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}', script), 'Unsafe script name'
                            assert not script.lower().startswith(('python', 'pip', 'activate')), 'Reserved script name'
            total += item.file_size
            assert total <= limit, 'Wheel uncompressed size exceeded'
            actual = 0
            with archive.open(item) as source:
                while True:
                    block = source.read(min(65536, limit - actual + 1))
                    if not block:
                        break
                    actual += len(block)
                    assert actual <= item.file_size and actual <= limit, 'Invalid wheel size'
            assert actual == item.file_size, 'Invalid wheel size'
print(json.dumps({'uncompressedBytes': total}))`

/** -S prevents startup hooks; only the trusted venv pip tree is put on sys.path. */
export const RUN_PIP = `import runpy, sys
site = sys.argv.pop(1)
sys.prefix = sys.exec_prefix = sys.argv.pop(1)
sys.executable = sys.argv.pop(1)
sys.path.append(site)
sys.argv[0] = 'pip'
runpy.run_module('pip', run_name='__main__')`
