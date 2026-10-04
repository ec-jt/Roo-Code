import * as vscode from "vscode"
import type { HistoryItem, ModelOperationState, ModeConfig } from "@roo-code/types"

import { ClineProvider } from "../core/webview/ClineProvider"
import { Task } from "../core/task/Task"
import {
	canAutoApproveNestedSubtasks,
	delegationContext,
	isEqualOrNarrowerMode,
	resolveDelegationAncestry,
} from "../core/task/delegation-policy"
import { NativeToolCallParser } from "../core/assistant-message/NativeToolCallParser"
import newTaskSchema from "../core/prompts/tools/native-tools/new_task"

const APPROVE = "Approve this delegation only"

function fixture(depth = 1) {
	const history = new Map<string, Partial<HistoryItem>>()
	for (let i = 0; i <= depth; i++) {
		history.set(`task-${i}`, { id: `task-${i}`, parentTaskId: i ? `task-${i - 1}` : undefined })
	}
	const parent = {
		taskId: `task-${depth}`,
		instanceId: "instance-1",
		parentTaskId: depth ? `task-${depth - 1}` : undefined,
		api: {},
		modelOperationState: { revision: 0, requiresToolApproval: false } as ModelOperationState,
		assertCanDelegate: vi.fn().mockResolvedValue(undefined),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		abort: false,
		abandoned: false,
	}
	const state = {
		mode: "code",
		currentApiConfigName: "default",
		apiConfiguration: {},
		customModes: [] as ModeConfig[],
		autoApprovalEnabled: true,
		alwaysAllowNestedSubtasks: undefined as boolean | undefined,
		alwaysAllowAll: true,
		alwaysAllowSubtasks: true,
	}
	const child = { taskId: "new-child", start: vi.fn() }
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		delegationRevision: 0,
		getCurrentTask: vi.fn(() => parent),
		getState: vi.fn(async () => state),
		getTaskWithId: vi.fn(async (id: string) => {
			if (!history.has(id)) throw new Error("Task not found")
			return { historyItem: history.get(id) }
		}),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		createTask: vi.fn().mockResolvedValue(child),
		handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		emit: vi.fn(),
		log: vi.fn(),
	})
	const request = {
		parentTaskId: parent.taskId,
		message: "Investigate one bounded issue",
		mode: "code",
		initialTodos: [],
	}
	return { history, parent, state, provider, request, child }
}

describe("durable delegation policy", () => {
	beforeEach(() => vi.spyOn(vscode.window, "showWarningMessage").mockReset())
	afterEach(() => vi.restoreAllMocks())

	it("allows root delegation to wider modes and subsequent siblings without an exception prompt", async () => {
		const f = fixture(0)
		f.state.mode = "orchestrator"
		await f.provider.delegateParentAndOpenChild(f.request)
		await f.provider.delegateParentAndOpenChild(f.request)
		expect(f.provider.createTask).toHaveBeenCalledTimes(2)
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
	})

	it.each([1, 2])("blocks restored depth %i without a reason even with all auto-approval enabled", async (depth) => {
		const f = fixture(depth)
		f.state.alwaysAllowNestedSubtasks = true
		await expect(f.provider.delegateParentAndOpenChild(f.request)).rejects.toThrow("concrete 'reason'")
		expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
	})

	it.each([1, 2])("requires a separate modal approval for each action at restored depth %i", async (depth) => {
		const f = fixture(depth)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(APPROVE as never)
		const request = { ...f.request, reason: "An isolated trace exceeds the remaining context budget" }
		await f.provider.delegateParentAndOpenChild(request)
		await f.provider.delegateParentAndOpenChild(request)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2)
		expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
			"Allow an exceptional deeper subtask?",
			{ modal: true, detail: expect.stringContaining(request.reason) },
			APPROVE,
		)
		expect(f.provider.log).toHaveBeenCalledWith(expect.stringContaining("Human approved one action"))
	})

	it.each([1, 2])("auto-approves a justified request at depth %i only with the nested opt-in", async (depth) => {
		const f = fixture(depth)
		f.state.alwaysAllowNestedSubtasks = true
		await f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated implementation context" })
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.provider.createTask).toHaveBeenCalledTimes(1)
		expect(f.provider.log).toHaveBeenCalledWith(
			expect.stringContaining("Nested auto-approval authorized one action"),
		)
	})

	it.each([
		{ autoApprovalEnabled: false, alwaysAllowNestedSubtasks: true },
		{ alwaysAllowNestedSubtasks: false },
		{ alwaysAllowNestedSubtasks: undefined },
		{ alwaysAllowNestedSubtasks: true, alwaysAllowAll: false, alwaysAllowSubtasks: false },
	])("retains per-action manual approval when a required gate is missing: %j", async (overrides) => {
		const f = fixture()
		Object.assign(f.state, overrides)
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(APPROVE as never)
		await f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" })
		expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
		expect(f.provider.createTask).toHaveBeenCalledTimes(1)
	})

	it.each(["alwaysAllowSubtasks", "alwaysAllowAll"] as const)("accepts the %s category gate", async (category) => {
		const f = fixture()
		Object.assign(f.state, { alwaysAllowNestedSubtasks: true, alwaysAllowAll: false, alwaysAllowSubtasks: false })
		f.state[category] = true
		await f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" })
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		expect(f.provider.createTask).toHaveBeenCalledTimes(1)
	})

	it.each(["autoApprovalEnabled", "alwaysAllowNestedSubtasks", "alwaysAllowSubtasks", "alwaysAllowAll"] as const)(
		"cancels if %s is revoked during the history flush",
		async (setting) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = true
			f.parent.flushPendingToolResultsToHistory.mockImplementation(async () => {
				f.state[setting] = false
				return true
			})
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow("approval settings changed")
			expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
			expect(f.provider.createTask).not.toHaveBeenCalled()
		},
	)

	it.each(["revision", "requiresToolApproval", "approval"] as const)(
		"cancels if model-operation %s changes during the history flush",
		async (field) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = true
			f.parent.flushPendingToolResultsToHistory.mockImplementation(async () => {
				if (field === "revision") f.parent.modelOperationState.revision++
				if (field === "requiresToolApproval") f.parent.modelOperationState.requiresToolApproval = true
				if (field === "approval")
					f.parent.modelOperationState.approval = { approvalId: "pending" } as ModelOperationState["approval"]
				return true
			})
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow("changed")
			expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
			expect(f.provider.createTask).not.toHaveBeenCalled()
		},
	)

	it("does not bypass model-operation branch restrictions with the nested opt-in", async () => {
		const f = fixture()
		f.state.alwaysAllowNestedSubtasks = true
		f.parent.modelOperationState.requiresToolApproval = true
		f.parent.assertCanDelegate.mockRejectedValue(new Error("model-operation branch"))
		await expect(
			f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
		).rejects.toThrow("model-operation branch")
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
	})

	it.each(["requiresToolApproval", "approval"] as const)(
		"never auto-approves with a model-operation %s fence",
		async (field) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = true
			if (field === "requiresToolApproval") f.parent.modelOperationState.requiresToolApproval = true
			if (field === "approval")
				f.parent.modelOperationState.approval = { approvalId: "pending" } as ModelOperationState["approval"]
			expect(canAutoApproveNestedSubtasks(f.state, f.parent.modelOperationState)).toBe(false)
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow("denied")
			expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1)
			expect(f.provider.createTask).not.toHaveBeenCalled()
		},
	)

	it("denial or dismissal stays in the child and does not allow auto-approval to bypass it", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined)
		await expect(
			f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
		).rejects.toThrow("report the limitation to the parent")
		expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
		expect(f.provider.createTask).not.toHaveBeenCalled()
	})

	it.each(["missing parent", "missing current", "cycle", "root mismatch", "lost parent"])(
		"fails closed on %s ancestry",
		async (kind) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = true
			if (kind === "missing parent") f.history.delete("task-0")
			if (kind === "missing current") f.history.delete("task-1")
			if (kind === "cycle") f.history.set("task-0", { id: "task-0", parentTaskId: "task-1" })
			if (kind === "root mismatch") f.history.get("task-1")!.rootTaskId = "missing-root"
			if (kind === "lost parent") f.history.get("task-1")!.parentTaskId = undefined
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow("ancestry")
			expect(f.provider.createTask).not.toHaveBeenCalled()
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		},
	)

	it.each(["task", "mode", "profile", "revision", "api", "abort", "ancestry", "permissions"])(
		"invalidates pending approval after a %s change",
		async (kind) => {
			const f = fixture()
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				if (kind === "task") f.provider.getCurrentTask.mockReturnValue({ ...f.parent })
				if (kind === "mode") f.state.mode = "debug"
				if (kind === "profile") f.state.currentApiConfigName = "other"
				if (kind === "revision") f.provider.delegationRevision++
				if (kind === "api") f.parent.api = {}
				if (kind === "abort") f.parent.abort = true
				if (kind === "ancestry") f.history.delete("task-0")
				if (kind === "permissions")
					f.state.customModes = [{ slug: "code", name: "Code", roleDefinition: "Code", groups: ["read"] }]
				return APPROVE as never
			})
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow()
			expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
			expect(f.provider.createTask).not.toHaveBeenCalled()
		},
	)

	it.each(["task", "mode", "profile", "revision", "api", "abort", "ancestry", "permissions"])(
		"invalidates nested auto approval after a %s change during the history flush",
		async (kind) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = true
			f.parent.flushPendingToolResultsToHistory.mockImplementation(async () => {
				if (kind === "task") f.provider.getCurrentTask.mockReturnValue({ ...f.parent })
				if (kind === "mode") f.state.mode = "debug"
				if (kind === "profile") f.state.currentApiConfigName = "other"
				if (kind === "revision") f.provider.delegationRevision++
				if (kind === "api") f.parent.api = {}
				if (kind === "abort") f.parent.abort = true
				if (kind === "ancestry") f.history.delete("task-0")
				if (kind === "permissions")
					f.state.customModes = [{ slug: "code", name: "Code", roleDefinition: "Code", groups: ["read"] }]
				return true
			})
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow()
			expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
			expect(f.provider.createTask).not.toHaveBeenCalled()
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		},
	)

	it("rechecks after the asynchronous history flush", async () => {
		const f = fixture()
		vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(APPROVE as never)
		f.parent.flushPendingToolResultsToHistory.mockImplementation(async () => {
			f.provider.delegationRevision++
			return true
		})
		await expect(
			f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
		).rejects.toThrow("changed")
		expect(f.provider.removeClineFromStack).not.toHaveBeenCalled()
	})

	it("rejects stale originating instances and ordinary approval revisions before prompting", async () => {
		const f = fixture()
		await expect(
			f.provider.delegateParentAndOpenChild({
				...f.request,
				parentInstanceId: "old-instance",
				reason: "Need isolated context",
			}),
		).rejects.toThrow("changed")
		await expect(
			f.provider.delegateParentAndOpenChild({
				...f.request,
				expectedRevision: -1,
				reason: "Need isolated context",
			}),
		).rejects.toThrow("changed")
		expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
	})

	it.each(["mode", "profile", "settings"])(
		"invalidates even a %s switch away and back while approval is pending",
		async (kind) => {
			const f = fixture()
			f.provider.contextProxy = { setValue: vi.fn(), setValues: vi.fn() }
			f.provider.providerSettingsManager = {
				activateProfile: vi.fn().mockRejectedValue(new Error("stop after invalidation")),
			}
			vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
				for (let i = 0; i < 2; i++) {
					try {
						if (kind === "mode")
							await ClineProvider.prototype.handleModeSwitch.call(f.provider, i ? "code" : "debug")
						if (kind === "profile")
							await ClineProvider.prototype.activateProviderProfile.call(f.provider, {
								name: i ? "default" : "other",
							})
						if (kind === "settings")
							await ClineProvider.prototype.setValue.call(f.provider, "mode", i ? "code" : "debug")
					} catch {
						/* The mocked backend stops after synchronous invalidation. */
					}
				}
				return APPROVE as never
			})
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" }),
			).rejects.toThrow("changed")
			expect(f.provider.createTask).not.toHaveBeenCalled()
		},
	)

	it("does not let concurrent direct calls share a pending approval", async () => {
		const f = fixture()
		let release!: (value: never) => void
		vi.mocked(vscode.window.showWarningMessage).mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const first = f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need isolated context" })
		await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalled())
		await expect(f.provider.delegateParentAndOpenChild(f.request)).rejects.toThrow("already pending")
		release(APPROVE as never)
		await first
		expect(f.provider.createTask).toHaveBeenCalledTimes(1)
	})

	it("binds approval to a cloned destination, message, and todos", async () => {
		const f = fixture()
		const request = { ...f.request, reason: "Need isolated context" }
		vi.mocked(vscode.window.showWarningMessage).mockImplementation(async () => {
			request.mode = "debug"
			request.message = "Changed content"
			return APPROVE as never
		})
		await f.provider.delegateParentAndOpenChild(request)
		expect(f.provider.handleModeSwitch).toHaveBeenCalledWith("code")
		expect(f.provider.createTask).toHaveBeenCalledWith(f.request.message, undefined, f.parent, expect.anything())
	})

	it.each([false, true])(
		"blocks restricted children from wider modes with nested auto approval %s",
		async (enabled) => {
			const f = fixture()
			f.state.alwaysAllowNestedSubtasks = enabled
			f.state.mode = "architect"
			await expect(
				f.provider.delegateParentAndOpenChild({ ...f.request, reason: "Need code edits" }),
			).rejects.toThrow("wider or unproven")
			expect(vscode.window.showWarningMessage).not.toHaveBeenCalled()
		},
	)

	it("enforces model-operation branch restrictions even on direct root provider calls", async () => {
		const f = fixture(0)
		f.parent.assertCanDelegate.mockRejectedValue(new Error("model-operation branch"))
		await expect(f.provider.delegateParentAndOpenChild(f.request)).rejects.toThrow("model-operation branch")
		expect(f.provider.createTask).not.toHaveBeenCalled()
	})

	it("restores branch provenance before checking its no-delegation policy", async () => {
		const task = {
			ensureModelOperationProvenance: vi.fn(async () => {
				task.modelOperationAdmission.requiresApproval = true
			}),
			modelOperationAdmission: { requiresApproval: false },
		}
		await expect(Task.prototype.assertCanDelegate.call(task as unknown as Task)).rejects.toThrow(
			"model-operation branch",
		)
		expect(task.ensureModelOperationProvenance).toHaveBeenCalled()
	})

	it("resolves restored grandchildren from history with no live parent references or stack", async () => {
		const f = fixture(2)
		expect(await resolveDelegationAncestry(f.parent, async (id) => f.history.get(id) as HistoryItem)).toEqual([
			"task-2",
			"task-1",
			"task-0",
		])
	})
})

describe("conservative child capability comparison", () => {
	const mode = (groups: ModeConfig["groups"]): ModeConfig => ({
		slug: "test",
		name: "Test",
		roleDefinition: "Test",
		groups,
	})
	it("allows identical restrictions and group removal, but not changed regexes, missing restrictions or added groups", () => {
		const narrow = mode(["read", ["edit", { fileRegex: "\\.md$" }]])
		expect(isEqualOrNarrowerMode(narrow, narrow)).toBe(true)
		expect(isEqualOrNarrowerMode(narrow, mode(["read"]))).toBe(true)
		expect(isEqualOrNarrowerMode(narrow, mode(["read", "edit"]))).toBe(false)
		expect(isEqualOrNarrowerMode(narrow, mode([["edit", { fileRegex: "docs/.*\\.md$" }]]))).toBe(false)
		expect(isEqualOrNarrowerMode(narrow, mode(["read", "command"]))).toBe(false)
		expect(isEqualOrNarrowerMode(mode(["edit"]), narrow)).toBe(false)
		expect(isEqualOrNarrowerMode(mode(["read", "edit"]), narrow)).toBe(true)
	})
})

describe("depth guidance and native justification plumbing", () => {
	it.each([undefined, 0, 1, 2])("provides explicit guidance for depth %s", (depth) => {
		expect(delegationContext(depth)).toMatchSnapshot()
	})
	it.each([1, 2])("explains effective nested auto approval at depth %i without removing safeguards", (depth) => {
		const guidance = delegationContext(depth, true)
		expect(guidance).toContain("Nested-subtask auto approval is explicitly enabled")
		expect(guidance).toContain("concrete reason, equal or narrower tool/file capabilities")
		expect(guidance).toContain("Do not create further subtasks by default")
		expect(guidance).toContain("caller constraints")
		expect(guidance).not.toContain("explicit per-action human approval")
	})
	it("does not advertise nested auto approval for unknown ancestry", () => {
		expect(delegationContext(undefined, true)).toContain("delegation is blocked")
	})
	it.each(["Need an isolated trace", null, undefined])("parses optional reason %s", (reason) => {
		const result = NativeToolCallParser.parseToolCall({
			id: "call-1",
			name: "new_task",
			arguments: JSON.stringify({ mode: "code", message: "Investigate", reason }),
		})
		expect(result?.type === "tool_use" && result.nativeArgs).toMatchObject({
			mode: "code",
			reason: reason ?? undefined,
		})
	})
	it("exposes a nullable reason in the strict native schema", () => {
		expect(newTaskSchema.function.parameters.properties.reason.type).toEqual(["string", "null"])
		expect(newTaskSchema.function.description).toContain("Children execute their assignment directly")
	})

	it("retains reason during streaming parsing", () => {
		NativeToolCallParser.startStreamingToolCall("reason-stream", "new_task")
		const result = NativeToolCallParser.processStreamingChunk(
			"reason-stream",
			JSON.stringify({ mode: "code", message: "Investigate", reason: "Need isolated context" }),
		)
		expect(result?.nativeArgs).toMatchObject({ reason: "Need isolated context" })
		NativeToolCallParser.clearAllStreamingToolCalls()
	})
})
