import type * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { BrowserSession } from "../BrowserSession"

describe("BrowserSession screenshot writes", () => {
	let cwd: string
	let session: BrowserSession
	const screenshot = vi.fn()
	beforeEach(async () => {
		vi.resetAllMocks()
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roo-browser-save-test-"))
		session = new BrowserSession({ globalState: { get: () => undefined } } as unknown as vscode.ExtensionContext)
		;(session as any).page = { screenshot }
		screenshot.mockResolvedValue(Buffer.from("image data"))
		vi.spyOn(session, "doAction").mockResolvedValue({ screenshot: "data:image/png;base64,aW1hZ2U=" })
	})
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})

	it.each(["png", "jpg", "jpeg", "webp"])(
		"writes %s from a buffer without passing a path to Puppeteer",
		async (extension) => {
			const result = await session.saveScreenshot(`nested/image.${extension}`, cwd)
			expect(await fs.readFile(path.join(cwd, `nested/image.${extension}`), "utf8")).toBe("image data")
			expect(screenshot).toHaveBeenCalledWith({
				type: extension === "jpg" ? "jpeg" : extension,
				quality: extension === "png" ? undefined : 75,
			})
			expect(result.screenshot).toBeDefined()
		},
	)
	it("rejects a symlink destination even when called without the tool boundary", async () => {
		await fs.writeFile(path.join(cwd, "original.png"), "original")
		await fs.symlink(path.join(cwd, "original.png"), path.join(cwd, "link.png"))
		await expect(session.saveScreenshot("link.png", cwd)).rejects.toThrow("symbolic links")
		expect(screenshot).not.toHaveBeenCalled()
		expect(await fs.readFile(path.join(cwd, "original.png"), "utf8")).toBe("original")
	})
	it("revalidates after browser capture and propagates write errors instead of reporting success", async () => {
		screenshot.mockImplementation(async () => {
			await fs.symlink(os.tmpdir(), path.join(cwd, "nested"))
			return Buffer.from("image")
		})
		await expect(session.saveScreenshot("nested/image.png", cwd)).rejects.toThrow("symbolic links")
		expect(session.doAction).not.toHaveBeenCalled()
	})
	it("rechecks authorization before making directories after capture", async () => {
		const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("ignored"))
		await expect(session.saveScreenshot("nested/image.png", cwd, authorize)).rejects.toThrow("ignored")
		expect(await fs.readdir(cwd)).toEqual([])
		expect(session.doAction).not.toHaveBeenCalled()
	})
})
