import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { listFiles } from "../list-files"

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "roo-ignore-safe-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})
it("does not read symlinked ignore files", async () => {
	await fs.writeFile(path.join(root, "rules"), "*")
	await fs.symlink(path.join(root, "rules"), path.join(root, ".gitignore"))
	await expect(listFiles(root, true, 100)).rejects.toThrow("not a regular file")
	const [files] = await listFiles(root, false, 100)
	expect(files).toContain(path.join(root, ".gitignore"))
})
it("rejects oversized ignore files rather than reading unbounded content", async () => {
	await fs.writeFile(path.join(root, ".gitignore"), "#".repeat(65537))
	await expect(listFiles(root, true, 100)).rejects.toThrow("64 KiB")
})
it("does not read a policy-denied ignore file", async () => {
	await fs.writeFile(path.join(root, ".gitignore"), "#".repeat(65537))
	const result = await listFiles(root, true, 100, { policy: { cwd: root, content: ".gitignore" } })
	expect(result.ignoredPaths?.has(path.join(root, ".gitignore"))).toBe(true)
})
