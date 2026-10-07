import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { FileSystemTool } from "../FileSystemTool"
import { MarkdownifyTool } from "../MarkdownifyTool"
import { extractTextFromFile } from "../../../integrations/misc/extract-text"
import { listFiles } from "../../../services/glob/list-files"
import { regexSearchFiles } from "../../../services/ripgrep"

vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../services/glob/list-files", () => ({ listFiles: vi.fn() }))
vi.mock("../../../services/ripgrep", () => ({ regexSearchFiles: vi.fn() }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: () => false }))
vi.mock("../../../utils/path", () => ({ getReadablePath: (_cwd: string, value: string) => value }))

const filesystem = new FileSystemTool()
const markdownify = new MarkdownifyTool()
const cases = [
	{
		name: "filesystem read",
		tool: filesystem,
		params: { action: "read_text_file", path: "test.txt" },
		operation: extractTextFromFile,
	},
	{
		name: "filesystem list",
		tool: filesystem,
		params: { action: "list_directory", path: "." },
		operation: listFiles,
	},
	{
		name: "filesystem search",
		tool: filesystem,
		params: { action: "search_files", path: ".", regex: "test" },
		operation: regexSearchFiles,
	},
	{ name: "markdownify file", tool: markdownify, params: { path: "test.txt" }, operation: extractTextFromFile },
	{ name: "markdownify URL", tool: markdownify, params: { url: "https://example.com" }, operation: vi.fn() },
] as const

describe.each(cases)("$name execution recovery", ({ tool, params, operation }) => {
	let task: Task
	let callbacks: ToolCallbacks
	const execute = () => tool.execute(params as never, task, callbacks)
	beforeEach(() => {
		vi.resetAllMocks()
		vi.useFakeTimers()
		task = {
			cwd: "/workspace",
			abort: false,
			say: vi.fn(),
			rooIgnoreController: { validateAccess: () => true },
			urlContentFetcher: { fetchMarkdown: operation },
		} as unknown as Task
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn().mockImplementation(async (_action, error) => {
				callbacks.pushToolResult(`Error: ${error.message}`)
			}),
		}
	})
	afterEach(() => {
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
	})

	it("reports rejected operations rather than rejecting the tool handler", async () => {
		vi.mocked(operation).mockRejectedValue(new Error("operation failed"))
		await execute()
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("Error: operation failed")
	})

	it("times out a stalled operation and discards late results", async () => {
		let finish!: (value: never) => void
		vi.mocked(operation).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}) as never,
		)
		const pending = execute()
		await vi.advanceTimersByTimeAsync(60_000)
		await pending
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("timed out after 60 seconds"),
		)
		finish("late result" as never)
		await vi.advanceTimersByTimeAsync(0)
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
	})

	it("stops waiting on task cancellation without publishing an error or late result", async () => {
		let fail!: (error: Error) => void
		vi.mocked(operation).mockImplementation(
			() =>
				new Promise((_, reject) => {
					fail = reject
				}) as never,
		)
		const pending = execute()
		await vi.advanceTimersByTimeAsync(0)
		task.abort = true
		await vi.advanceTimersByTimeAsync(100)
		await pending
		fail(new Error("late failure"))
		await vi.advanceTimersByTimeAsync(0)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("does not time out approval or execute a denied operation", async () => {
		let approve!: (value: boolean) => void
		vi.mocked(callbacks.askApproval).mockReturnValue(
			new Promise((resolve) => {
				approve = resolve
			}),
		)
		const pending = execute()
		await vi.advanceTimersByTimeAsync(120_000)
		expect(operation).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		approve(false)
		await pending
	})
})
