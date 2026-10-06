import fs from "fs/promises"
import os from "os"
import path from "path"
import simpleGit, { type SimpleGit } from "simple-git"

import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"
import { CheckpointStorageProtection, MAX_CHECKPOINT_FILE_BYTES, splitGitPaths } from "../storageProtection"

vi.mock("../../search/file-search", () => ({ executeRipgrep: vi.fn().mockResolvedValue([]) }))

describe("checkpoint storage protection (real Git)", () => {
	let root: string
	let workspace: string
	let service: RepoPerTaskCheckpointService
	let git: SimpleGit

	const write = async (name: string, content = "small source") => {
		const file = path.join(workspace, name)
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(file, content)
		return file
	}
	const large = async (name: string) => {
		const file = await write(name)
		// Sparse fixture, not actual model data.
		await fs.truncate(file, MAX_CHECKPOINT_FILE_BYTES + 1)
		return file
	}
	const tracked = async () => splitGitPaths(await git.raw(["ls-files", "-z"]))
	const objects = async () =>
		git.raw(["cat-file", "--batch-all-objects", "--batch-check=%(objecttype) %(objectsize)"])

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "roo-checkpoint-protection-"))
		workspace = path.join(root, "workspace")
		await fs.mkdir(workspace)
		await write("source.ts", "original")
		service = new RepoPerTaskCheckpointService("test", path.join(root, "shadow"), workspace, () => {})
		service.on("error", () => {})
		await service.initShadowGit()
		git = simpleGit(service.checkpointsDir)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("excludes serialized weights but retains model code, configuration and shard indexes", async () => {
		for (const ext of ["safetensors", "gguf", "ggml", "ckpt", "pt", "pth", "onnx", "h5", "hdf5"]) {
			await write(`models/weights.${ext}`)
		}
		const retained = ["models/config.json", "models/model.safetensors.index.json", "models/model.py"]
		for (const name of retained) await write(name)
		await service.saveCheckpoint("models")
		expect(await tracked()).toEqual([...retained, "source.ts"].sort())
		await service.restoreCheckpoint(service.baseHash!)
		expect(await fs.readFile(path.join(workspace, "models/weights.safetensors"), "utf8")).toBe("small source")
	})

	it("prunes small environment/cache files without gitignore on initial and later snapshots", async () => {
		const excluded = [
			".venv/lib/module.py",
			"nested/.venv/lib/module.py",
			".cache/uv/archive/module.py",
			"nested/.uv-cache/archive/module.py",
			".tox/test/lib/module.py",
			".pnpm-store/pkg/index.js",
			"nested/.yarn/cache/pkg/index.js",
			"artifacts/batch.npy",
		]
		const retained = [
			"pyproject.toml",
			"uv.lock",
			"uv.toml",
			"nested/uv.lock",
			"requirements.txt",
			"models/config.json",
			"artifacts/config.json",
			".yarn/patches/fix.patch",
		]
		for (const name of [...excluded, ...retained]) await write(name)
		service = new RepoPerTaskCheckpointService("initial", path.join(root, "initial-shadow"), workspace, () => {})
		const stat = vi.spyOn(fs, "lstat")
		await service.initShadowGit()
		git = simpleGit(service.checkpointsDir)
		expect(await tracked()).toEqual([...retained, "source.ts"].sort())
		for (const name of excluded)
			expect(stat.mock.calls.some(([file]) => file === path.join(workspace, name))).toBe(false)
		await write(".venv/new.py", "new dependency")
		await write("source.ts", "changed")
		await service.saveCheckpoint("source only")
		expect(await tracked()).toEqual([...retained, "source.ts"].sort())
		await service.restoreCheckpoint(service.baseHash!)
		expect(await fs.readFile(path.join(workspace, ".venv/new.py"), "utf8")).toBe("new dependency")
		for (const name of excluded) expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe("small source")
	})

	it("untracks legacy virtual environments without deleting files or rewriting history", async () => {
		const name = ".venv/lib/legacy.py"
		const file = await write(name, "valuable local environment")
		await git.add(["-f", name])
		const legacy = await git.commit("legacy environment snapshot")
		await service.saveCheckpoint("exclude environment")
		expect(await tracked()).not.toContain(name)
		expect(await git.show([`${legacy.commit}:${name}`])).toBe("valuable local environment")
		await service.restoreCheckpoint(service.baseHash!)
		expect(await fs.readFile(file, "utf8")).toBe("valuable local environment")
		await expect(service.restoreCheckpoint(legacy.commit)).rejects.toThrow("Checkpoint restore blocked")
	})

	it("keeps explicit workspace ignore and LFS rules authoritative for dependency lockfiles", async () => {
		await write("uv.lock", "ignored dependency definition")
		await write("poetry.lock", "LFS managed definition")
		await write(".gitignore", "uv.lock\n")
		await write(".gitattributes", "poetry.lock filter=lfs diff=lfs merge=lfs -text\n")
		await service.saveCheckpoint("respect workspace policy")
		expect(await tracked()).not.toContain("uv.lock")
		expect(await tracked()).not.toContain("poetry.lock")
	})

	it("skips unknown and extensionless oversized files before ingestion, including initial snapshots", async () => {
		await large("models/unknown.payload")
		await large("extensionless")
		service = new RepoPerTaskCheckpointService("initial", path.join(root, "initial-shadow"), workspace, () => {})
		await service.initShadowGit()
		git = simpleGit(service.checkpointsDir)
		expect(await tracked()).toEqual(["source.ts"])
		expect(await objects()).not.toContain(`blob ${MAX_CHECKPOINT_FILE_BYTES + 1}`)
	})

	it("includes a file exactly at the 10 MiB ceiling", async () => {
		const file = await write("at-limit")
		await fs.truncate(file, MAX_CHECKPOINT_FILE_BYTES)
		await service.saveCheckpoint("boundary")
		expect(await tracked()).toContain("at-limit")
		expect(await objects()).toContain(`blob ${MAX_CHECKPOINT_FILE_BYTES}`)
	})

	it("untracks a source file that grows beyond the ceiling without ingesting or deleting it", async () => {
		const file = await large("source.ts")
		await write("other.ts")
		await service.saveCheckpoint("source became artifact")
		expect(await tracked()).toEqual(["other.ts"])
		expect((await fs.stat(file)).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
		expect(await objects()).not.toContain(`blob ${MAX_CHECKPOINT_FILE_BYTES + 1}`)
		await expect(service.restoreCheckpoint(service.baseHash!)).rejects.toThrow("Checkpoint restore blocked")
		expect((await fs.stat(file)).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
	})

	it("untracks old excluded artifacts index-only and restores source-only snapshots without deleting them", async () => {
		const file = await write("weights.safetensors", "legacy weight")
		await git.add(["-f", "weights.safetensors"])
		await git.commit("legacy snapshot")
		await write("source.ts", "new source")
		await service.saveCheckpoint("protected snapshot")
		expect(await tracked()).toEqual(["source.ts"])
		await service.restoreCheckpoint(service.baseHash!)
		expect(await fs.readFile(file, "utf8")).toBe("legacy weight")
		expect(await fs.readFile(path.join(workspace, "source.ts"), "utf8")).toBe("original")
	})

	it("preserves a legacy weight after preview untracking even before a new checkpoint commit", async () => {
		const file = await write("weights.safetensors", "preserve")
		await git.add(["-f", "weights.safetensors"])
		const legacy = await git.commit("legacy")
		expect(await service.getDiff({ from: legacy.commit })).toEqual([])
		expect(await tracked()).not.toContain("weights.safetensors")
		await service.restoreCheckpoint(service.baseHash!)
		expect(await fs.readFile(file, "utf8")).toBe("preserve")
	})

	it("refuses legacy targets containing excluded blobs before cleaning any worktree files", async () => {
		const file = await write("weights.safetensors", "legacy weight")
		await git.add(["-f", "weights.safetensors"])
		const old = await git.commit("legacy snapshot")
		await service.saveCheckpoint("untrack legacy weight")
		await fs.writeFile(file, "valuable current weight")
		const untracked = await write("untracked.ts", "keep on failure")
		await expect(service.restoreCheckpoint(old.commit)).rejects.toThrow("Checkpoint restore blocked")
		expect(await fs.readFile(file, "utf8")).toBe("valuable current weight")
		expect(await fs.readFile(untracked, "utf8")).toBe("keep on failure")
	})

	it("refuses historical oversized blobs even when the working file is now small", async () => {
		const file = await large("unknown.payload")
		await git.add(["unknown.payload"])
		const old = await git.commit("legacy oversized snapshot")
		await fs.writeFile(file, "now small")
		await service.saveCheckpoint("small snapshot")
		await expect(service.restoreCheckpoint(old.commit)).rejects.toThrow("Checkpoint restore blocked")
		expect(await fs.readFile(file, "utf8")).toBe("now small")
		// No history rewrite or pruning: the old object remains available.
		expect(await objects()).toContain(`blob ${MAX_CHECKPOINT_FILE_BYTES + 1}`)
		expect(await service.getDiff({ from: old.commit })).toEqual([])
	})

	it("refuses deleting a still-indexed excluded artifact when restoring a source-only checkpoint", async () => {
		const file = await write("weights.gguf", "preserve")
		await git.add(["-f", "weights.gguf"])
		await git.commit("legacy")
		await expect(service.restoreCheckpoint(service.baseHash!)).rejects.toThrow("Checkpoint restore blocked")
		expect(await fs.readFile(file, "utf8")).toBe("preserve")
	})

	it("aborts staging if a candidate grows between inspection and ingestion", async () => {
		const checkpoint = vi.fn()
		service.on("checkpoint", checkpoint)
		const original = fs.lstat.bind(fs)
		let inspections = 0
		vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
			if (args[0] === path.join(workspace, "source.ts") && ++inspections === 2) {
				await fs.truncate(path.join(workspace, "source.ts"), MAX_CHECKPOINT_FILE_BYTES + 1)
			}
			return original(...args)
		})
		await expect(service.saveCheckpoint("racing write")).rejects.toThrow("changed during staging")
		expect(checkpoint).not.toHaveBeenCalled()
		expect(await objects()).not.toContain(`blob ${MAX_CHECKPOINT_FILE_BYTES + 1}`)
	})

	it("rejects a file that grows after the last preflight check without publishing an oversized checkpoint", async () => {
		const checkpoint = vi.fn()
		service.on("checkpoint", checkpoint)
		const head = await git.revparse(["HEAD"])
		const inspect = CheckpointStorageProtection.prototype.inspect
		let inspections = 0
		vi.spyOn(CheckpointStorageProtection.prototype, "inspect").mockImplementation(async function (
			this: CheckpointStorageProtection,
			file,
		) {
			const result = await inspect.call(this, file)
			if (file === "source.ts" && ++inspections === 2) {
				await fs.truncate(path.join(workspace, file), MAX_CHECKPOINT_FILE_BYTES + 1)
			}
			return result
		})
		await expect(service.saveCheckpoint("late racing write")).rejects.toThrow("exceeded 10 MiB during staging")
		expect(checkpoint).not.toHaveBeenCalled()
		expect(await git.revparse(["HEAD"])).toBe(head)
		expect(await tracked()).not.toContain("source.ts")
		expect((await fs.stat(path.join(workspace, "source.ts"))).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
	})

	it("propagates Git staging failures rather than committing a partial snapshot", async () => {
		const checkpoint = vi.fn()
		service.on("checkpoint", checkpoint)
		const head = await git.revparse(["HEAD"])
		await write("source.ts", "new content")
		await fs.writeFile(path.join(service.checkpointsDir, ".git", "index.lock"), "test lock")
		await expect(service.saveCheckpoint("locked index")).rejects.toThrow()
		expect(checkpoint).not.toHaveBeenCalled()
		expect(await git.revparse(["HEAD"])).toBe(head)
	})

	it("preserves oversized untracked files during normal restore and still removes eligible new source", async () => {
		const protectedFile = await large("new directory/unknown")
		await write("new directory/code.ts")
		await write("source.ts", "changed")
		await service.restoreCheckpoint(service.baseHash!)
		expect((await fs.stat(protectedFile)).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
		await expect(fs.stat(path.join(workspace, "new directory/code.ts"))).rejects.toThrow()
		expect(await fs.readFile(path.join(workspace, "source.ts"), "utf8")).toBe("original")
	})

	it("preserves deletion tracking and treats spaces, glob characters and newlines literally", async () => {
		const names = ["space name.ts", "[ab]*.ts", ":(glob)*.ts", "line\nbreak.ts", "-option.ts"]
		if (process.platform === "win32") names.splice(1, 3)
		for (const name of names) await write(name, name)
		await large("not-included")
		const snapshot = await service.saveCheckpoint("special names")
		expect(await tracked()).toEqual([...names, "source.ts"].sort())
		for (const name of names) await fs.unlink(path.join(workspace, name))
		await service.saveCheckpoint("delete special names")
		expect(await tracked()).toEqual(["source.ts"])
		await service.restoreCheckpoint(snapshot!.commit)
		for (const name of names) expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(name)
	})

	it("does not stat ignored Git or LFS trees and still removes already tracked ignored files", async () => {
		await write("formerly.ts")
		await service.saveCheckpoint("previously tracked")
		await write(".gitignore", "ignored/\nformerly.ts\n")
		await write(".gitattributes", "lfs/** filter=lfs diff=lfs merge=lfs -text\n")
		await large("ignored/model")
		await large("lfs/model")
		const stat = vi.spyOn(fs, "lstat")
		await service.saveCheckpoint("ignored trees")
		expect(await tracked()).not.toContain("formerly.ts")
		expect(await fs.readFile(path.join(workspace, "formerly.ts"), "utf8")).toBe("small source")
		expect(stat.mock.calls.some(([file]) => /[/\\](ignored|lfs)([/\\]|$)/.test(String(file)))).toBe(false)
	})

	it("fails without a checkpoint success event when metadata inspection fails", async () => {
		const checkpoint = vi.fn()
		service.on("checkpoint", checkpoint)
		const head = await git.revparse(["HEAD"])
		const original = fs.lstat.bind(fs)
		vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
			if (args[0] === path.join(workspace, "source.ts")) throw new Error("metadata access denied")
			return original(...args)
		})
		await expect(service.saveCheckpoint("must fail")).rejects.toThrow("metadata access denied")
		expect(checkpoint).not.toHaveBeenCalled()
		expect(await git.revparse(["HEAD"])).toBe(head)
	})

	it("does not follow symlinks to outside artifacts or restore across symlinked parents", async () => {
		if (process.platform === "win32") return
		const outside = path.join(root, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "valuable"), "outside data")
		await fs.symlink(outside, path.join(workspace, "linked"))
		await write("nested/code.ts")
		const snapshot = await service.saveCheckpoint("nested source")
		expect(await tracked()).not.toContain("linked")
		await fs.rm(path.join(workspace, "nested"), { recursive: true })
		await fs.symlink(outside, path.join(workspace, "nested"))
		await expect(service.restoreCheckpoint(snapshot!.commit)).rejects.toThrow("Checkpoint restore blocked")
		expect(await fs.readFile(path.join(outside, "valuable"), "utf8")).toBe("outside data")
		expect((await fs.lstat(path.join(workspace, "nested"))).isSymbolicLink()).toBe(true)
	})

	it("refuses replacing a directory containing protected files with a historical regular file", async () => {
		await write("directory-later")
		const snapshot = await service.saveCheckpoint("file")
		await fs.unlink(path.join(workspace, "directory-later"))
		const weight = await large("directory-later/weights")
		await expect(service.restoreCheckpoint(snapshot!.commit)).rejects.toThrow("Checkpoint restore blocked")
		expect((await fs.stat(weight)).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
	})
})
