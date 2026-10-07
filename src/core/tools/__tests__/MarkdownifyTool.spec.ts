import { MarkdownifyTool } from "../MarkdownifyTool"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { extractTextFromFile } from "../../../integrations/misc/extract-text"

vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: vi.fn(() => true) }))
vi.mock("../../../utils/path", () => ({ getReadablePath: (_cwd: string, value: string) => value }))

describe("MarkdownifyTool URL access boundaries", () => {
	const tool = new MarkdownifyTool()
	let task: Task
	let callbacks: ToolCallbacks

	beforeEach(() => {
		vi.clearAllMocks()
		task = {
			cwd: "/workspace",
			say: vi.fn(),
			rooIgnoreController: { validateAccess: vi.fn(() => false) },
			urlContentFetcher: {
				launchBrowser: vi.fn(),
				fetchMarkdown: vi.fn().mockResolvedValue("Web content"),
			},
		} as unknown as Task
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
		} as unknown as ToolCallbacks
	})

	it.each([
		"file:///outside/blocked.txt",
		"FiLe:///workspace/blocked.txt",
		"data:text/html,private",
		"javascript:alert(1)",
		"ftp://example.com/file",
		"/outside/blocked.txt",
		"not a URL",
	])("rejects %s before approval or browser launch", async (url) => {
		await tool.execute({ url }, task, callbacks)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(task.urlContentFetcher.launchBrowser).not.toHaveBeenCalled()
		expect(extractTextFromFile).not.toHaveBeenCalled()
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalled()
	})

	it.each(["http://example.com/page", "https://example.com/page"])("allows %s after approval", async (url) => {
		await tool.execute({ url }, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalled()
		expect(task.urlContentFetcher.fetchMarkdown).toHaveBeenCalledWith(url, expect.any(AbortSignal))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Web content")
	})

	it("keeps local paths subject to outside-workspace approval and ignore checks", async () => {
		await tool.execute({ path: "../blocked.txt" }, task, callbacks)
		const approval = JSON.parse(vi.mocked(callbacks.askApproval).mock.calls[0][1]!)
		expect(approval.isOutsideWorkspace).toBe(true)
		expect(task.rooIgnoreController!.validateAccess).toHaveBeenCalledWith("../blocked.txt")
		expect(extractTextFromFile).not.toHaveBeenCalled()
		expect(task.urlContentFetcher.launchBrowser).not.toHaveBeenCalled()
	})

	it("does not retrieve a web page when approval is denied", async () => {
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute({ url: "https://example.com" }, task, callbacks)
		expect(task.urlContentFetcher.launchBrowser).not.toHaveBeenCalled()
	})
})
