import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { Context7QueryDocsTool } from "../Context7QueryDocsTool"
import { Context7ResolveLibraryIdTool } from "../Context7ResolveLibraryIdTool"
import { context7QueryDocs, context7ResolveLibraryId } from "../../../services/native-tools/context7"

vi.mock("../../../services/native-tools/context7", () => ({
	context7QueryDocs: vi.fn(),
	context7ResolveLibraryId: vi.fn(),
	formatContext7DocsResponse: vi.fn(() => "Documentation result"),
	formatContext7SearchResponse: vi.fn(() => "Library result"),
}))

describe.each([
	{
		tool: new Context7QueryDocsTool(),
		request: context7QueryDocs,
		value: "/vercel/next.js",
		result: "Documentation result",
		field: "libraryId",
	},
	{
		tool: new Context7ResolveLibraryIdTool(),
		request: context7ResolveLibraryId,
		value: "next.js",
		result: "Library result",
		field: "libraryName",
	},
])("$tool.name optional authentication", ({ tool, request, value, result, field }) => {
	let task: Task
	let callbacks: ToolCallbacks
	const params = { libraryId: "/vercel/next.js", libraryName: "next.js", query: "routing examples" }
	let state: { context7ApiKey?: string }

	beforeEach(() => {
		vi.clearAllMocks()
		state = {}
		task = {
			providerRef: { deref: () => ({ getState: async () => state }) },
			consecutiveMistakeCount: 2,
			didToolFailInCurrentTurn: false,
			say: vi.fn(),
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter"),
		} as unknown as Task
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		}
	})

	it.each([undefined, "", " \t "])("executes after approval with key %j", async (apiKey) => {
		state.context7ApiKey = apiKey
		await tool.execute(params, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledWith("tool", expect.any(String))
		expect(request).toHaveBeenCalledWith(apiKey, value, params.query)
		expect(vi.mocked(callbacks.askApproval).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(request).mock.invocationCallOrder[0],
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(result)
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.didToolFailInCurrentTurn).toBe(false)
		expect(task.say).not.toHaveBeenCalled()
	})

	it("does not call the service when anonymous access is denied", async () => {
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute(params, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalled()
		expect(request).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it.each([field, "query"])("still validates the required %s parameter", async (missingField) => {
		await tool.execute({ ...params, [missingField]: "" }, task, callbacks)
		expect(task.sayAndCreateMissingParamError).toHaveBeenCalledWith(tool.name, missingField)
		expect(task.recordToolError).toHaveBeenCalledWith(tool.name)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(request).not.toHaveBeenCalled()
	})
})
