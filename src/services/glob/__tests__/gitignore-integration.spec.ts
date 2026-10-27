import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listFiles } from "../list-files"

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "roo-ignore-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})
async function file(name: string, text = "") {
	await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
	await fs.writeFile(path.join(root, name), text)
}
it("filters ignored directories and files in recursive mode", async () => {
	await file(".gitignore", "ignored/\n*.log\n!keep.log\n")
	for (const name of ["ignored/file", "src/file", "bad.log", "keep.log"]) await file(name)
	const [files] = await listFiles(root, true, 100)
	expect(files).toContain(path.join(root, "src", "file"))
	expect(files).toContain(path.join(root, "keep.log"))
	expect(files).not.toContain(path.join(root, "bad.log"))
	expect(files).not.toContain(path.join(root, "ignored") + "/")
})
it("applies nested and ancestor ignore rules relative to their own directory", async () => {
	await file(".gitignore", "/src/ancestor-ignored/\n")
	await file("src/.gitignore", "nested-ignored/\n")
	for (const name of [
		"src/ancestor-ignored/file",
		"src/nested-ignored/file",
		"src/allowed/file",
		"other/nested-ignored/file",
	])
		await file(name)
	const [files] = await listFiles(path.join(root, "src"), true, 100)
	expect(files).toContain(path.join(root, "src", "allowed", "file"))
	expect(files.some((name) => name.includes("ancestor-ignored") || name.includes("nested-ignored"))).toBe(false)
	const [all] = await listFiles(root, true, 100)
	expect(all).toContain(path.join(root, "other", "nested-ignored", "file"))
})
it("shallow listing never reads ignore contents and shows direct entries", async () => {
	await file(".gitignore", "ignored/\n*.log\n")
	await file("ignored/file")
	await file("visible.log")
	const [files] = await listFiles(root, false, 100)
	expect(files).toContain(path.join(root, "ignored") + "/")
	expect(files).toContain(path.join(root, "visible.log"))
	expect(files).not.toContain(path.join(root, "ignored", "file"))
})

it("honors nested negations of ancestor file patterns", async () => {
	await file(".gitignore", "*.log\n")
	await file("src/.gitignore", "!keep.log\n")
	await file("src/keep.log")
	await file("src/drop.log")
	const [files] = await listFiles(root, true, 100)
	expect(files).toContain(path.join(root, "src", "keep.log"))
	expect(files).not.toContain(path.join(root, "src", "drop.log"))
})
