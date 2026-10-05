import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { validateScreenshotPath, writeScreenshot } from "../screenshotPath"

vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))

describe("screenshot filesystem boundary", () => {
	let base: string
	let cwd: string
	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "roo-screenshot-test-"))
		cwd = path.join(base, "workspace")
		await fs.mkdir(cwd)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(base, { recursive: true, force: true })
	})

	it("creates safe nested paths and overwrites ordinary files", async () => {
		await writeScreenshot("screens/a/image.png", cwd, Buffer.from("first"))
		await writeScreenshot("screens/a/image.png", cwd, Buffer.from("new"))
		expect(await fs.readFile(path.join(cwd, "screens/a/image.png"), "utf8")).toBe("new")
	})
	it.each(["../outside.png", "../../outside.png", "."])("rejects %s", async (destination) => {
		await expect(writeScreenshot(destination, cwd, Buffer.from("data"))).rejects.toThrow("inside the workspace")
	})
	it.each(["parent", "file", "dangling", "internal"])("rejects %s symlinks before writing", async (kind) => {
		const outside = path.join(base, "outside")
		await fs.mkdir(outside)
		await fs.writeFile(path.join(outside, "image.png"), "original")
		const target =
			kind === "internal"
				? cwd
				: kind === "parent"
					? outside
					: path.join(outside, kind === "dangling" ? "missing.png" : "image.png")
		const link = path.join(cwd, kind === "parent" || kind === "internal" ? "link" : "link.png")
		await fs.symlink(target, link)
		const destination = kind === "parent" || kind === "internal" ? "link/new/image.png" : "link.png"
		await expect(writeScreenshot(destination, cwd, Buffer.from("data"))).rejects.toThrow("symbolic links")
		expect(await fs.readFile(path.join(outside, "image.png"), "utf8")).toBe("original")
		expect(await fs.readdir(outside)).toEqual(["image.png"])
	})
	it("rejects hard-linked files without changing the other link", async () => {
		const outside = path.join(base, "outside.png")
		await fs.writeFile(outside, "original")
		await fs.link(outside, path.join(cwd, "image.png"))
		await expect(writeScreenshot("image.png", cwd, Buffer.from("data"))).rejects.toThrow("non-hard-linked")
		expect(await fs.readFile(outside, "utf8")).toBe("original")
	})
	it("rechecks paths after an earlier validation", async () => {
		await validateScreenshotPath("image.png", cwd)
		const outside = path.join(base, "outside.png")
		await fs.writeFile(outside, "original")
		await fs.symlink(outside, path.join(cwd, "image.png"))
		await expect(writeScreenshot("image.png", cwd, Buffer.from("data"))).rejects.toThrow("symbolic links")
		expect(await fs.readFile(outside, "utf8")).toBe("original")
	})
	it("does not create directories when access is denied", async () => {
		await expect(
			writeScreenshot("new/image.png", cwd, Buffer.from("data"), async () => {
				throw new Error("ignored")
			}),
		).rejects.toThrow("ignored")
		expect(await fs.readdir(cwd)).toEqual([])
	})

	it("does not truncate a symlink substituted just before open", async () => {
		const outside = path.join(base, "outside.png")
		await fs.writeFile(outside, "original")
		const originalOpen = fs.open
		vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
			await fs.symlink(outside, path.join(cwd, "image.png"))
			return originalOpen(...args)
		})
		await expect(writeScreenshot("image.png", cwd, Buffer.from("data"))).rejects.toThrow()
		expect(await fs.readFile(outside, "utf8")).toBe("original")
	})
})
