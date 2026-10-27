import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listFiles } from "../list-files"

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "roo-list-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})
async function file(name: string) {
	await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
	await fs.writeFile(path.join(root, name), "")
}
const names = (files: string[]) =>
	files.map((name) => path.relative(root, name).split(path.sep).join("/") + (name.endsWith("/") ? "/" : ""))

it("returns immediately for zero limit and retains root/home guards", async () => {
	expect(await listFiles(root, true, 0)).toEqual([[], false])
	expect(await listFiles(path.parse(root).root, true, 100)).toEqual([[path.parse(root).root], false])
	expect(await listFiles(os.homedir(), false, 100)).toEqual([[os.homedir()], false])
})
it("lists only direct entries, including hidden files and empty directories", async () => {
	await file(".hidden-file")
	await file("visible/child")
	await fs.mkdir(path.join(root, "empty"))
	const [files, limited] = await listFiles(root, false, 100)
	expect(names(files)).toEqual(["empty/", "visible/", ".hidden-file"])
	expect(limited).toBe(false)
})
it("lists discovered symlinks without following them, including cycles and broken links", async () => {
	await file("dir/file")
	await fs.symlink(root, path.join(root, "dir", "cycle"), "junction")
	await fs.symlink(path.join(root, "missing"), path.join(root, "broken"), "junction")
	const [files] = await listFiles(root, true, 100)
	expect(names(files)).toEqual(["dir/", "broken", "dir/cycle", "dir/file"])
})
it("does not traverse hidden directories during a general scan", async () => {
	await file(".git/objects/object")
	await file(".config/private")
	await file("src/components/file")
	const [files] = await listFiles(root, true, 100)
	expect(names(files)).toContain(".config/")
	expect(names(files)).toContain("src/components/file")
	expect(files.some((name) => name.includes(".git") || name.endsWith("private"))).toBe(false)
})
it.each([".hidden/", "normal/.hidden/subdir/", ".roo/temp"])("allows explicit hidden target %s", async (target) => {
	await file(`${target}/top`)
	await file(`${target}/22/nested`)
	await file(`${target}/node_modules/excluded`)
	const [files] = await listFiles(path.join(root, target), true, 100)
	expect(files).toContain(path.join(root, target, "top"))
	expect(files).toContain(path.join(root, target, "22", "nested"))
	expect(files.some((name) => name.endsWith("excluded"))).toBe(false)
})
it("reports missing directories as errors rather than empty listings", async () => {
	await expect(listFiles(path.join(root, "missing"), false, 100)).rejects.toThrow()
})
it("refuses a policy-denied target before starting a filesystem operation", async () => {
	await expect(
		listFiles(path.join(root, "denied"), true, 100, { policy: { cwd: root, content: "denied/" } }),
	).rejects.toThrow("denied by .rooignore")
})
it("does not scan ignored subdirectories and records their visibility policy", async () => {
	await file("denied/private")
	await file("allowed/file")
	const result = await listFiles(root, true, 100, { policy: { cwd: root, content: "denied/" } })
	expect(result.ignoredPaths).toEqual(new Set([path.join(root, "denied")]))
	expect(result[0]).not.toContain(path.join(root, "denied", "private"))
})
it("checks the canonical target against cached policy before scanning an alias", async () => {
	await fs.mkdir(path.join(root, "denied"))
	await fs.symlink(path.join(root, "denied"), path.join(root, "alias"), "junction")
	await expect(
		listFiles(path.join(root, "alias"), false, 100, { policy: { cwd: root, content: "denied/" } }),
	).rejects.toThrow("denied by .rooignore")
})
