import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { Task } from "../../task/Task"
import type { ToolUse } from "../../../shared/tools"
import { browserActionTool } from "../BrowserActionTool"
import { checkAutoApproval } from "../../auto-approval"

describe("browser screenshot authorization", () => {
	let cwd: string
	let task: Task
	let state: any
	const askApproval = vi.fn()
	const handleError = vi.fn()
	const pushToolResult = vi.fn()
	const saveScreenshot = vi.fn()
	const validateAccess = vi.fn()
	const isWriteProtected = vi.fn()
	beforeEach(async () => {
		vi.resetAllMocks()
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "roo-browser-tool-test-"))
		state = { mode: "code", customModes: [] }
		askApproval.mockResolvedValue(true)
		saveScreenshot.mockResolvedValue({})
		validateAccess.mockReturnValue(true)
		isWriteProtected.mockReturnValue(false)
		task = {
			cwd,
			providerRef: { deref: () => ({ getState: async () => state }) },
			rooIgnoreController: { validateAccess },
			rooProtectedController: { isWriteProtected },
			browserSession: { saveScreenshot, scrollDown: vi.fn().mockResolvedValue({}) },
			say: vi.fn(),
			broadcastBrowserSessionUpdate: vi.fn(),
		} as unknown as Task
	})
	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true })
	})
	const run = (filePath = "screens/image.png", action = "screenshot") =>
		browserActionTool(
			task,
			{
				type: "tool_use",
				name: "browser_action",
				params: { action, path: filePath },
				partial: false,
			} as ToolUse,
			askApproval,
			handleError,
			pushToolResult,
		)

	it("requests destination-specific write approval and preserves normal screenshots", async () => {
		await run()
		expect(handleError).not.toHaveBeenCalled()
		expect(JSON.parse(askApproval.mock.calls[0][1])).toMatchObject({
			tool: "newFileCreated",
			path: "screens/image.png",
			isProtected: false,
		})
		expect(saveScreenshot).toHaveBeenCalledWith("screens/image.png", cwd, expect.any(Function))
		expect(task.didEditFile).toBe(true)
	})
	it("classifies existing files as overwrites", async () => {
		await fs.writeFile(path.join(cwd, "image.png"), "existing")
		await run("image.png")
		expect(JSON.parse(askApproval.mock.calls[0][1]).tool).toBe("editedExistingFile")
	})
	it("does not let browser auto-approval authorize file writes", async () => {
		await run()
		const approvalState = { autoApprovalEnabled: true, alwaysAllowBrowser: true } as any
		expect(
			await checkAutoApproval({ state: approvalState, ask: "tool", text: askApproval.mock.calls[0][1] }),
		).toEqual({ decision: "ask" })
		expect(
			await checkAutoApproval({
				state: { ...approvalState, alwaysAllowWrite: true },
				ask: "tool",
				text: askApproval.mock.calls[0][1],
			}),
		).toEqual({ decision: "approve" })
	})
	it("does not save when write approval is denied", async () => {
		askApproval.mockResolvedValue(false)
		await run()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("blocks ignored paths before approval or filesystem mutation", async () => {
		validateAccess.mockReturnValue(false)
		await run()
		expect(askApproval).not.toHaveBeenCalled()
		expect(saveScreenshot).not.toHaveBeenCalled()
		expect(handleError).toHaveBeenCalled()
		expect(await fs.readdir(cwd)).toEqual([])
	})
	it.each(["ask", "architect"])("blocks screenshot writes in %s mode", async (mode) => {
		state.mode = mode
		await run()
		expect(handleError).toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("honors custom edit file restrictions on the normalized path", async () => {
		state.mode = "screenshots"
		state.customModes = [
			{
				slug: "screenshots",
				name: "Screenshots",
				roleDefinition: "Test",
				groups: ["browser", ["edit", { fileRegex: "^screens/.*\\.png$" }]],
			},
		]
		await run("screens/../blocked.png")
		expect(handleError).toHaveBeenCalled()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("allows destinations permitted by a custom edit restriction", async () => {
		state.mode = "screenshots"
		state.customModes = [
			{
				slug: "screenshots",
				name: "Screenshots",
				roleDefinition: "Test",
				groups: ["browser", ["edit", { fileRegex: "^screens/.*\\.png$" }]],
			},
		]
		await run()
		expect(saveScreenshot).toHaveBeenCalled()
	})
	it("honors disabled file writing", async () => {
		state.disabledTools = ["write_to_file"]
		await run()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("passes protection to the write approval gate", async () => {
		isWriteProtected.mockReturnValue(true)
		await run()
		expect(askApproval.mock.calls[0][3]).toBe(true)
	})
	it("rechecks ignore rules after approval", async () => {
		askApproval.mockImplementation(async () => {
			validateAccess.mockReturnValue(false)
			return true
		})
		await run()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("rejects symlink parents before approval", async () => {
		await fs.symlink(os.tmpdir(), path.join(cwd, "screens"))
		await run()
		expect(askApproval).not.toHaveBeenCalled()
		expect(saveScreenshot).not.toHaveBeenCalled()
	})
	it("does not require edit permission for ordinary browser actions", async () => {
		state.mode = "ask"
		await run("", "scroll_down")
		expect(task.browserSession.scrollDown).toHaveBeenCalled()
		expect(askApproval).not.toHaveBeenCalled()
	})
})
