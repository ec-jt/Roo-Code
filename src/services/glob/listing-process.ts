import { spawn, type ChildProcessWithoutNullStreams } from "child_process"

// Only built-in Node modules are used here. Keeping the program inline also works in
// the bundled VSIX, without a separately packaged worker or a ripgrep installation.
export const LISTING_PROCESS_SOURCE = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
let directory;
const respond = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  try {
    const { operation, path } = JSON.parse(line);
    let value;
    if (operation === 'realpath') value = fs.realpathSync(path);
    else if (operation === 'open') {
      if (directory) { directory.closeSync(); directory = undefined; }
      if (fs.realpathSync(path) !== path) throw new Error('Directory path changed during listing');
      if (fs.lstatSync(path).isSymbolicLink()) throw new Error('Directory changed to a symbolic link');
      directory = fs.opendirSync(path, { bufferSize: 32 });
      value = true;
    } else if (operation === 'read') {
      value = [];
      for (let i = 0; i < 32; i++) {
        const entry = directory.readSync();
        if (!entry) { directory.closeSync(); directory = undefined; break; }
        value.push({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
      }
    } else if (operation === 'ignore') {
      value = '';
      let fd;
      try {
        if (!fs.lstatSync(path).isFile()) throw new Error('Ignore file is not a regular file');
        fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 65536) throw new Error('Ignore file is not a regular file of at most 64 KiB');
        const buffer = Buffer.alloc(65537);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (count > 65536) throw new Error('Ignore file exceeds 64 KiB');
        value = buffer.toString('utf8', 0, count);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    } else throw new Error('Unknown listing operation');
    respond({ value });
  } catch (error) { respond({ error: error.message }); }
});
`

// A kernel-blocked child may not exit even after SIGKILL. Keep its slot occupied
// until exit, rather than starting arbitrarily many blocked children on retries.
const liveChildren = new Set<ChildProcessWithoutNullStreams>()
const MAX_CHILDREN = 4

export class ListingProcess {
	private child: ChildProcessWithoutNullStreams
	private pending?: { resolve: (value: unknown) => void; reject: (error: Error) => void }
	private buffer = ""
	private stopped?: Error
	private escalation?: NodeJS.Timeout

	constructor() {
		if (liveChildren.size >= MAX_CHILDREN)
			throw new Error("Directory listing workers are still stopping; try again later.")
		this.child = spawn(process.execPath, ["--eval", LISTING_PROCESS_SOURCE], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "" },
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		})
		liveChildren.add(this.child)
		this.child.stdout.setEncoding("utf8")
		this.child.stdout.on("data", this.onData)
		this.child.stderr.resume()
		this.child.stdin.on("error", this.onError)
		this.child.on("error", this.onError)
		this.child.once("exit", this.onExit)
		this.child.once("close", this.onExit)
	}

	private onData = (chunk: string) => {
		if (this.stopped) return
		this.buffer += chunk
		if (this.buffer.length > 512 * 1024) {
			this.stop(new Error("Directory listing worker response exceeded its size limit"))
			return
		}
		const end = this.buffer.indexOf("\n")
		if (end < 0) return
		const pending = this.pending
		this.pending = undefined
		try {
			const response = JSON.parse(this.buffer.slice(0, end))
			this.buffer = this.buffer.slice(end + 1)
			if (response.error) pending?.reject(new Error(response.error))
			else pending?.resolve(response.value)
		} catch {
			pending?.reject(new Error("Invalid directory listing worker response"))
			this.stop()
		}
	}

	private onError = (error: Error) => this.stop(error)
	private onExit = () => {
		liveChildren.delete(this.child)
		clearTimeout(this.escalation)
		this.child.removeListener("exit", this.onExit)
		this.child.removeListener("close", this.onExit)
		this.stop(new Error("Directory listing worker exited"), false)
	}

	request<T>(operation: "realpath" | "open" | "read" | "ignore", path?: string): Promise<T> {
		if (this.stopped) return Promise.reject(this.stopped)
		if (this.pending) return Promise.reject(new Error("Only one listing operation may be in flight"))
		return new Promise((resolve, reject) => {
			this.pending = { resolve: (value) => resolve(value as T), reject }
			this.child.stdin.write(JSON.stringify({ operation, path }) + "\n")
		})
	}

	stop(error = new Error("Directory listing stopped"), kill = true): void {
		if (this.stopped) return
		this.stopped = error
		this.pending?.reject(error)
		this.pending = undefined
		this.buffer = ""
		this.child.stdout.removeListener("data", this.onData)
		this.child.stdin.destroy()
		this.child.stdout.destroy()
		this.child.stderr.destroy()
		if (kill) {
			this.child.kill("SIGTERM")
			this.escalation = setTimeout(() => {
				this.child.kill("SIGKILL")
				this.child.unref()
			}, 250)
			this.escalation.unref()
		}
	}
}
