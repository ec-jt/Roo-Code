import { EventEmitter } from "node:events"
import { RooCodeEventName } from "@roo-code/types"
import type { Task } from "../../task/Task"
import { ManagedEnvironmentTool } from "../ManagedEnvironmentTool"
import {
	prepareEnvironment,
	installEnvironment,
	inspectEnvironments,
	type ManagedEnvironmentPlan,
} from "../../../services/managed-environments"
import { getManagedEnvironmentPolicy } from "../../../services/managed-environments/settings"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { TOOL_GROUPS } from "../../../shared/tools"

vi.mock("../../../services/managed-environments", () => ({
	prepareEnvironment: vi.fn(),
	installEnvironment: vi.fn(),
	inspectEnvironments: vi.fn(),
}))
vi.mock("../../../services/managed-environments/settings", () => ({ getManagedEnvironmentPolicy: vi.fn() }))

describe("ManagedEnvironmentTool", () => {
	const tool = new ManagedEnvironmentTool()
	const policy = {
		root: "/managed",
		pythonPath: "/python",
		maxDownloadBytes: 512,
		maxDiskBytes: 2048,
		timeoutMs: 600000,
	}
	const params = { action: "install", manifest_path: "roo-environment.json" } as const
	let task: Task
	let callbacks: {
		askApproval: ReturnType<typeof vi.fn>
		handleError: ReturnType<typeof vi.fn>
		pushToolResult: ReturnType<typeof vi.fn>
	}
	let plan: ManagedEnvironmentPlan

	beforeEach(() => {
		vi.resetAllMocks()
		task = Object.assign(new EventEmitter(), {
			cwd: "/workspace",
			taskId: "test-task",
			abort: false,
			abandoned: false,
			providerRef: { deref: () => ({ getState: vi.fn().mockResolvedValue({}) }) },
			rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
			rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		}) as unknown as Task
		callbacks = { askApproval: vi.fn().mockResolvedValue(true), handleError: vi.fn(), pushToolResult: vi.fn() }
		plan = {
			workspaceDir: task.cwd,
			manifestPath: "/workspace/roo-environment.json",
			policy: { ...policy },
			manifest: {
				version: 1,
				pythonVersion: "3.11",
				packages: [
					{
						name: "example",
						version: "1.0",
						url: "https://files.pythonhosted.org/example-1.0-py3-none-any.whl",
						sha256: "a".repeat(64),
						sizeBytes: 123,
					},
				],
			},
			manifestSha256: "b".repeat(64),
			fingerprint: "c".repeat(64),
			environmentPath: "/managed/id/venv",
			interpreterPath: "/managed/id/venv/bin/python",
			pythonExecutableSha256: "d".repeat(64),
			platform: "linux",
			arch: "x64",
			totalDownloadBytes: 123,
		}
		vi.mocked(getManagedEnvironmentPolicy).mockReturnValue({ ...policy })
		vi.mocked(prepareEnvironment).mockResolvedValue(plan)
		vi.mocked(installEnvironment).mockResolvedValue({
			status: "ready",
			interpreterPath: plan.interpreterPath,
		} as never)
		vi.mocked(inspectEnvironments).mockResolvedValue({
			environments: [],
			manifestPaths: [],
			selected: null,
			manifestMismatch: false,
			incompleteCount: 0,
			invalidCount: 0,
		})
	})

	it("asks once with exact snapshot and installs the original plan only", async () => {
		await tool.execute(params, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		const approval = JSON.parse(callbacks.askApproval.mock.calls[0][1])
		expect(approval).toMatchObject({ tool: "managedEnvironment", action: "install", path: params.manifest_path })
		expect(JSON.parse(approval.content)).toEqual(plan)
		expect(installEnvironment).toHaveBeenCalledWith(plan, { taskId: task.taskId, signal: expect.any(AbortSignal) })
		expect(vi.mocked(installEnvironment).mock.calls[0][0]).toBe(plan)
		expect(prepareEnvironment).toHaveBeenCalledOnce()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
	})

	it("does not install after denial", async () => {
		callbacks.askApproval.mockResolvedValue(false)
		await tool.execute(params, task, callbacks)
		expect(installEnvironment).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it.each(["prepare", "status"] as const)("asks before any service read for %s", async (action) => {
		callbacks.askApproval.mockImplementation(async () => {
			expect(prepareEnvironment).not.toHaveBeenCalled()
			expect(inspectEnvironments).not.toHaveBeenCalled()
			return false
		})
		await tool.execute({ ...params, action }, task, callbacks)
		expect(prepareEnvironment).not.toHaveBeenCalled()
		expect(inspectEnvironments).not.toHaveBeenCalled()
		expect(installEnvironment).not.toHaveBeenCalled()
	})

	it("returns serializable inventory without execution", async () => {
		await tool.execute({ ...params, action: "status" }, task, callbacks)
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0])).toMatchObject({
			environments: [],
			selected: null,
		})
		expect(installEnvironment).not.toHaveBeenCalled()
		expect(prepareEnvironment).not.toHaveBeenCalled()
	})

	it.each(["root", "pythonPath", "maxDownloadBytes", "maxDiskBytes", "timeoutMs"] as const)(
		"rejects changed policy %s after approval",
		async (key) => {
			callbacks.askApproval.mockImplementation(async () => {
				vi.mocked(getManagedEnvironmentPolicy).mockReturnValue({
					...policy,
					[key]: typeof policy[key] === "string" ? "/changed" : 1234,
				})
				return true
			})
			await tool.execute(params, task, callbacks)
			expect(installEnvironment).not.toHaveBeenCalled()
			expect(callbacks.handleError.mock.calls[0][1].message).toContain("settings changed")
		},
	)

	it.each([false, true])("fails closed when disabled (after approval: %s)", async (afterApproval) => {
		const disable = () =>
			vi.mocked(getManagedEnvironmentPolicy).mockImplementation(() => {
				throw new Error("disabled")
			})
		if (afterApproval)
			callbacks.askApproval.mockImplementation(async () => {
				disable()
				return true
			})
		else disable()
		await tool.execute(params, task, callbacks)
		expect(installEnvironment).not.toHaveBeenCalled()
		if (!afterApproval) expect(prepareEnvironment).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledOnce()
	})

	it.each(["../escape.json", "/absolute.json", ".", ""])(
		"rejects manifest path %s before reads",
		async (manifest_path) => {
			await tool.execute({ ...params, manifest_path }, task, callbacks)
			expect(prepareEnvironment).not.toHaveBeenCalled()
			expect(installEnvironment).not.toHaveBeenCalled()
			expect(callbacks.handleError).toHaveBeenCalledOnce()
		},
	)

	it.each([false, true])("enforces ignore before service reads and after approval (%s)", async (afterApproval) => {
		const deny = () => vi.mocked(task.rooIgnoreController!.validateAccess).mockReturnValue(false)
		if (afterApproval)
			callbacks.askApproval.mockImplementation(async () => {
				deny()
				return true
			})
		else deny()
		await tool.execute(params, task, callbacks)
		expect(installEnvironment).not.toHaveBeenCalled()
		if (!afterApproval) expect(prepareEnvironment).not.toHaveBeenCalled()
		expect(callbacks.handleError.mock.calls[0][1].message).toContain(".rooignore")
	})

	it("blocks protected paths before reading", async () => {
		vi.mocked(task.rooProtectedController!.isWriteProtected).mockReturnValue(true)
		await tool.execute(params, task, callbacks)
		expect(prepareEnvironment).not.toHaveBeenCalled()
		expect(callbacks.handleError.mock.calls[0][1].message).toContain("protected path")
	})

	it("never starts installation after task abort during approval", async () => {
		callbacks.askApproval.mockImplementation(async () => {
			task.emit(RooCodeEventName.TaskAborted)
			return true
		})
		await tool.execute(params, task, callbacks)
		expect(installEnvironment).not.toHaveBeenCalled()
		expect(callbacks.handleError.mock.calls[0][1].message).toContain("cancelled")
	})

	it.each(["event", "flag"])("cancels active service using %s and cleans up", async (kind) => {
		vi.useFakeTimers()
		try {
			vi.mocked(installEnvironment).mockImplementation(async (_plan, { signal }) => {
				return new Promise((_, reject) =>
					signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
				)
			})
			const pending = tool.execute(params, task, callbacks)
			await vi.advanceTimersByTimeAsync(1)
			expect(installEnvironment).toHaveBeenCalledOnce()
			if (kind === "event") task.emit(RooCodeEventName.TaskAborted)
			else task.abort = true
			await vi.advanceTimersByTimeAsync(100)
			await pending
			expect(callbacks.handleError).toHaveBeenCalledOnce()
			expect(callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("rejects arbitrary shell or policy arguments", async () => {
		await tool.execute({ ...params, command: "pip install example", root: "/model" } as never, task, callbacks)
		expect(prepareEnvironment).not.toHaveBeenCalled()
		expect(installEnvironment).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledOnce()
	})

	it("is in the command group, never the read group", () => {
		expect(TOOL_GROUPS.command.tools).toContain(tool.name)
		expect(TOOL_GROUPS.read.tools).not.toContain(tool.name)
	})

	it.each(["prepare", "install", "status"])("parses native %s calls", (action) => {
		const result = NativeToolCallParser.parseToolCall({
			id: "managed-test",
			name: tool.name,
			arguments: JSON.stringify({ ...params, action }),
		})
		expect(result).toMatchObject({ name: tool.name, nativeArgs: { ...params, action } })
	})

	it.each([{ action: "delete", manifest_path: "x" }, { action: "install" }, { ...params, pythonPath: "/untrusted" }])(
		"rejects malformed native arguments %j",
		(args) => {
			const result = NativeToolCallParser.parseToolCallOrError({
				id: "managed-test",
				name: tool.name,
				arguments: JSON.stringify(args),
			})
			expect(result).toMatchObject({ argumentError: expect.any(String) })
		},
	)
})
