import path from "node:path"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { FileSystemTool } from "../FileSystemTool"
import { ListFilesTool } from "../ListFilesTool"
import { listFiles, type ListFilesResult } from "../../../services/glob/list-files"

vi.mock("../../../services/glob/list-files", () => ({ listFiles: vi.fn() }))
vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../services/ripgrep", () => ({ regexSearchFiles: vi.fn() }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: () => false }))
vi.mock("../../../utils/path", () => ({ getReadablePath: (_cwd: string, value: string) => value }))

describe.each([
	{ tool: new FileSystemTool(), params: { action: "list_directory", path: "." } },
	{ tool: new ListFilesTool(), params: { path: "." } },
])("$tool.name directory listing", ({ tool, params }) => {
	let task: Task
	let callbacks: ToolCallbacks
	beforeEach(() => {
		vi.resetAllMocks()
		vi.useFakeTimers()
		task = {
			cwd: path.resolve("/workspace"),
			consecutiveMistakeCount: 0,
			rooIgnoreController: {
				rooIgnoreContent: "denied/",
				validateAccess: vi.fn(() => {
					throw new Error("synchronous filesystem access")
				}),
			},
			rooProtectedController: { isWriteProtected: (filename: string) => filename.endsWith("AGENTS.md") },
			providerRef: { deref: () => ({ getState: async () => ({ showRooIgnoredFiles: true }) }) },
		} as unknown as Task
		callbacks = { askApproval: vi.fn().mockResolvedValue(true), pushToolResult: vi.fn(), handleError: vi.fn() }
	})
	afterEach(() => {
		expect(vi.getTimerCount()).toBe(0)
		vi.useRealTimers()
	})
	it("passes cancellation and cached policy, preserves protection annotations without synchronous path resolution", async () => {
		const result: ListFilesResult = [[path.join(task.cwd, "denied") + "/", path.join(task.cwd, "AGENTS.md")], true]
		result.ignoredPaths = new Set([path.join(task.cwd, "denied")])
		result.reason = "Directory listing timed out; these are partial results."
		vi.mocked(listFiles).mockResolvedValue(result)
		await tool.execute(params as never, task, callbacks)
		expect(listFiles).toHaveBeenCalledWith(task.cwd, false, 200, {
			signal: expect.any(AbortSignal),
			policy: { cwd: task.cwd, content: "denied/" },
		})
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("partial results"))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("AGENTS.md"))
		expect(task.rooIgnoreController?.validateAccess).not.toHaveBeenCalled()
	})
	it.each(["abort", "abandoned", "modelOperationDispatchClosed"])(
		"cancels and discards successful late results after %s",
		async (closed) => {
			let finish!: (value: ListFilesResult) => void
			vi.mocked(listFiles).mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve
					}),
			)
			const pending = tool.execute(params as never, task, callbacks)
			await vi.advanceTimersByTimeAsync(0)
			Object.defineProperty(task, closed, { value: true })
			await vi.advanceTimersByTimeAsync(100)
			await pending
			expect(vi.mocked(listFiles).mock.calls[0][3]?.signal?.aborted).toBe(true)
			finish([["late"], false])
			await vi.advanceTimersByTimeAsync(0)
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)
	it("does not scan when approval is denied", async () => {
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute(params as never, task, callbacks)
		expect(listFiles).not.toHaveBeenCalled()
	})
})
