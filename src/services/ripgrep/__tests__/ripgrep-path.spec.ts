import * as fs from "node:fs/promises"
import * as path from "node:path"
import { getBinPath } from "../ripgrep-path"

vi.mock("node:fs/promises", () => ({ stat: vi.fn(), access: vi.fn() }))

describe("extension-host ripgrep lookup", () => {
	const options = { execPath: "/server/lib/node", pathEnv: "", platform: "linux" as const }
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(fs.stat).mockRejectedValue(new Error("missing"))
		vi.mocked(fs.access).mockResolvedValue(undefined)
	})
	const exists = (candidate: string) =>
		vi.mocked(fs.stat).mockImplementation(async (file) => {
			if (file !== candidate) throw new Error("missing")
			return { isFile: () => true } as Awaited<ReturnType<typeof fs.stat>>
		})
	it("prefers the editor bundled binary", async () => {
		exists("/editor/node_modules/@vscode/ripgrep/bin/rg")
		expect(await getBinPath("/editor", options)).toBe("/editor/node_modules/@vscode/ripgrep/bin/rg")
	})
	it("supports code-server wrapper roots", async () => {
		exists("/server/lib/vscode/node_modules/@vscode/ripgrep/bin/rg")
		expect(await getBinPath("/server", options)).toBe("/server/lib/vscode/node_modules/@vscode/ripgrep/bin/rg")
	})
	it("uses the server executable layout when appRoot is unavailable", async () => {
		exists("/server/lib/vscode/node_modules/@vscode/ripgrep/bin/rg")
		expect(await getBinPath("", options)).toBe("/server/lib/vscode/node_modules/@vscode/ripgrep/bin/rg")
	})
	it("falls back to absolute PATH entries without using the workspace", async () => {
		exists("/usr/bin/rg")
		expect(
			await getBinPath("/missing", { ...options, pathEnv: ["", ".", "tools", "/usr/bin"].join(path.delimiter) }),
		).toBe("/usr/bin/rg")
		expect(vi.mocked(fs.stat).mock.calls.every(([file]) => path.isAbsolute(String(file)))).toBe(true)
	})
	it("rejects non-executable files and directories", async () => {
		exists("/editor/node_modules/@vscode/ripgrep/bin/rg")
		vi.mocked(fs.access).mockRejectedValue(new Error("EACCES"))
		expect(await getBinPath("/editor", options)).toBeUndefined()
		vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as Awaited<ReturnType<typeof fs.stat>>)
		expect(await getBinPath("/editor", options)).toBeUndefined()
	})
})
