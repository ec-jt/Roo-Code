import { Task } from "../../task/Task"
import { presentAssistantMessage } from "../presentAssistantMessage"
import { readFileTool } from "../../tools/ReadFileTool"
import { writeToFileTool } from "../../tools/WriteToFileTool"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { customToolRegistry } from "@roo-code/core"
import { allowlistedToolPolicy, compatibilityToolPolicy } from "../../tool-execution/invocation-policy"

vi.mock("../../tools/ReadFileTool", () => ({ readFileTool: { handle: vi.fn() } }))
vi.mock("../../tools/WriteToFileTool", () => ({ writeToFileTool: { handle: vi.fn() } }))
vi.mock("../../tools/UseMcpToolTool", () => ({ useMcpToolTool: { handle: vi.fn() } }))
vi.mock("@roo-code/core", () => ({ customToolRegistry: { has: vi.fn(), get: vi.fn() } }))

describe("presenter task policy boundary", () => {
	let task: Task
	let host: any
	let execute: ReturnType<typeof vi.fn>
	const builtin = {
		type: "tool_use",
		id: "call",
		name: "read_file",
		params: {},
		nativeArgs: { path: "a" },
		partial: false,
	}
	const custom = { ...builtin, name: "test_custom" }
	const native = {
		type: "mcp_tool_use",
		id: "call",
		name: "mcp--server--read-file",
		serverName: "server",
		toolName: "read_file",
		arguments: {},
		partial: false,
	}
	const wrapper = { ...builtin, name: "use_mcp_tool", nativeArgs: { server_name: "server", tool_name: "read_file" } }

	beforeEach(() => {
		vi.clearAllMocks()
		execute = vi.fn(async () => "done")
		vi.mocked(customToolRegistry.has).mockImplementation((name) => name === "test_custom")
		vi.mocked(customToolRegistry.get).mockImplementation((name) =>
			name === "test_custom" ? { name, description: "test", execute } : undefined,
		)
		host = {
			getState: vi.fn(async () => ({ mode: "code", customModes: [], experiments: { customTools: true } })),
			getMcpHub: () => ({
				findServerNameBySanitizedName: () => "server",
				getAllServers: () => [{ name: "server", tools: [{ name: "read-file" }] }],
			}),
		}
		task = Object.assign(Object.create(Task.prototype), {
			taskId: "task",
			instanceId: "instance",
			abort: false,
			modelOperationRevision: 0,
			toolInvocationPolicy: compatibilityToolPolicy,
			toolExecutionDisposed: false,
			presentAssistantMessageLocked: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [builtin],
			assistantMessageSavedToHistory: true,
			userMessageContent: [],
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			admitModelOperationTool: vi.fn(async () => true),
			api: { getModel: () => ({ info: {} }) },
			providerRef: { deref: () => host },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			checkpointSave: vi.fn(),
			toolRepetitionDetector: { check: () => ({ allowExecution: true }) },
			say: vi.fn(),
			ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
			pushToolResultToUserContent: vi.fn((result) => {
				task.userMessageContent.push(result)
				return true
			}),
		})
	})

	it.each([builtin, { ...builtin, name: "write_to_file" }, custom, native, wrapper])(
		"denies $name once before approval, checkpoints or handler effects",
		async (block) => {
			;(task as any).toolInvocationPolicy = allowlistedToolPolicy([])
			task.assistantMessageContent = [block] as any
			await presentAssistantMessage(task)
			expect(task.admitModelOperationTool).not.toHaveBeenCalled()
			expect(task.ask).not.toHaveBeenCalled()
			expect(task.checkpointSave).not.toHaveBeenCalled()
			expect(readFileTool.handle).not.toHaveBeenCalled()
			expect(writeToFileTool.handle).not.toHaveBeenCalled()
			expect(useMcpToolTool.handle).not.toHaveBeenCalled()
			expect(execute).not.toHaveBeenCalled()
			expect(task.userMessageContent).toHaveLength(1)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "call",
				is_error: true,
			})
			expect(task.didRejectTool).toBe(true)
			expect(task.presentAssistantMessageLocked).toBe(false)
		},
	)

	it.each([builtin, custom, native, wrapper])(
		"preserves allowed $name dispatch and existing admission",
		async (block) => {
			task.assistantMessageContent = [block] as any
			await presentAssistantMessage(task)
			expect(task.admitModelOperationTool).toHaveBeenCalledWith(block.name, "call")
			if (block === custom) expect(execute).toHaveBeenCalledTimes(1)
			else if (block === builtin) expect(readFileTool.handle).toHaveBeenCalledTimes(1)
			else expect(useMcpToolTool.handle).toHaveBeenCalledTimes(1)
		},
	)

	it("does not let policy allowance bypass disabled-tool validation", async () => {
		host.getState.mockResolvedValue({ mode: "code", disabledTools: ["read_file"] })
		await presentAssistantMessage(task)
		expect(readFileTool.handle).not.toHaveBeenCalled()
		expect(task.userMessageContent).toHaveLength(1)
		expect(task.didRejectTool).toBe(false)
		expect(task.consecutiveMistakeCount).toBe(1)
	})

	it.each(["throw", "reject"])("fails closed when policy %s fails", async (failure) => {
		;(task as any).toolInvocationPolicy = {
			evaluate: () => {
				if (failure === "throw") throw new Error("broken")
				return Promise.reject(new Error("broken"))
			},
		}
		await presentAssistantMessage(task)
		expect(task.admitModelOperationTool).not.toHaveBeenCalled()
		expect(readFileTool.handle).not.toHaveBeenCalled()
		expect(task.userMessageContent).toHaveLength(1)
	})

	it.each(["partial", "unpublished", "missing-id"])("retains %s handling without invoking policy", async (kind) => {
		const evaluate = vi.fn(() => ({ allow: false }))
		;(task as any).toolInvocationPolicy = { evaluate }
		task.assistantMessageContent = [
			{ ...builtin, partial: kind === "partial", id: kind === "missing-id" ? undefined : "call" },
		] as any
		task.assistantMessageSavedToHistory = kind !== "unpublished"
		await presentAssistantMessage(task)
		expect(evaluate).not.toHaveBeenCalled()
		expect(readFileTool.handle).not.toHaveBeenCalled()
		if (kind === "missing-id")
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("missing tool_use.id"))
		else expect(task.userMessageContent).toHaveLength(0)
	})

	it("skips subsequent calls after denial with exactly one result per call", async () => {
		;(task as any).toolInvocationPolicy = allowlistedToolPolicy([])
		task.assistantMessageContent = [builtin, { ...native, id: "second" }, { ...custom, id: "third" }] as any
		await presentAssistantMessage(task)
		expect(task.userMessageContent).toHaveLength(3)
		expect(task.admitModelOperationTool).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
		expect(useMcpToolTool.handle).not.toHaveBeenCalled()
	})

	it.each([native, wrapper])("resolves $name to an exact MCP catalog capability", async (block) => {
		;(task as any).toolInvocationPolicy = allowlistedToolPolicy([
			{ kind: "mcp", serverName: "server", toolName: "read-file" },
		])
		expect(await task.checkToolInvocation(block as any)).toEqual({ allow: true })
		;(task as any).toolInvocationPolicy = allowlistedToolPolicy([{ kind: "builtin", name: "use_mcp_tool" }])
		expect(await task.checkToolInvocation(block as any)).toMatchObject({ allow: false })
	})

	it("rejects ambiguous MCP catalogs instead of widening grants", async () => {
		;(task as any).toolInvocationPolicy = { evaluate: vi.fn(() => ({ allow: true })) }
		host.getMcpHub = () => ({
			findServerNameBySanitizedName: () => "server",
			getAllServers: () => [{ name: "server", tools: [{ name: "read_file" }, { name: "read-file" }] }],
		})
		expect(await task.checkToolInvocation(native as any)).toMatchObject({ allow: false })
		expect((task as any).toolInvocationPolicy.evaluate).not.toHaveBeenCalled()
	})

	it("rejects colliding native MCP server aliases", async () => {
		;(task as any).toolInvocationPolicy = { evaluate: vi.fn(() => ({ allow: true })) }
		host.getMcpHub = () => ({
			findServerNameBySanitizedName: () => "my server",
			getAllServers: () => ["my server", "my_server"].map((name) => ({ name, tools: [{ name: "read-file" }] })),
		})
		expect(await task.checkToolInvocation({ ...native, serverName: "my_server" } as any)).toMatchObject({
			allow: false,
		})
		expect((task as any).toolInvocationPolicy.evaluate).not.toHaveBeenCalled()
	})

	it("does not let capability allowance bypass mandatory model-operation admission", async () => {
		vi.mocked(task.admitModelOperationTool).mockResolvedValue(false)
		await presentAssistantMessage(task)
		expect(readFileTool.handle).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.userMessageContent).toHaveLength(1)
	})

	it.each([builtin, native])(
		"routes $name callback approval through the task-wide veto exactly once",
		async (block) => {
			const check = vi.fn(async () => ({ decision: "deny" as const }))
			;(task as any).approvalPort = { check }
			;(task as any).approvalSequence = 0
			task.ask = Task.prototype.ask
			task.assistantMessageContent = [block] as any
			const effect = vi.fn()
			const handler = block === builtin ? readFileTool.handle : useMcpToolTool.handle
			vi.mocked(handler).mockImplementationOnce(async (_task, _block, callbacks) => {
				if (await callbacks.askApproval(block === builtin ? "tool" : "use_mcp_server", "payload")) effect()
			})
			await presentAssistantMessage(task)
			expect(check).toHaveBeenCalledOnce()
			expect(effect).not.toHaveBeenCalled()
			expect(task.userMessageContent).toHaveLength(1)
			expect(task.didRejectTool).toBe(true)
		},
	)

	it.each(["abort", "modelOperationClosed", "toolExecutionDisposed", "modelOperationRevision"])(
		"rejects late policy allowance after %s changes",
		async (field) => {
			let release!: (value: { allow: true }) => void
			;(task as any).toolInvocationPolicy = {
				evaluate: () =>
					new Promise((resolve) => {
						release = resolve
					}),
			}
			const pending = task.checkToolInvocation(builtin as any)
			;(task as any)[field] = field === "modelOperationRevision" ? 1 : true
			release({ allow: true })
			expect(await pending).toMatchObject({ allow: false })
		},
	)
})
