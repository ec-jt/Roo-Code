import { handleAlwaysAllowReadOnlyAsk } from "../alwaysAllowReadOnlyHandler"
import type { ClineProvider } from "../ClineProvider"
import { checkAutoApproval } from "../../auto-approval"

describe("persistent Read approval", () => {
	const request = { taskId: "task", instanceId: "instance", revision: 2, askTs: 10 }
	const setup = () => {
		const settings = {
			autoApprovalEnabled: false,
			alwaysAllowReadOnly: false,
			alwaysAllowAll: false,
			alwaysAllowWrite: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
		}
		const task = {
			taskId: "task",
			instanceId: "instance",
			modelOperationState: { revision: 2, requiresToolApproval: false, approval: undefined as unknown },
			clineMessages: [
				{
					ts: 10,
					type: "ask" as const,
					ask: "tool" as const,
					text: JSON.stringify({ tool: "markdownify", url: "https://openvdn.github.io" }),
				},
			],
			isPendingToolAsk: vi.fn((ts: number) => ts === 10),
			handleWebviewAskResponse: vi.fn(),
		}
		const provider = {
			getCurrentTask: vi.fn(() => task),
			contextProxy: {
				getValue: vi.fn((key: keyof typeof settings) => settings[key]),
				setValues: vi.fn(async (values) => {
					Object.assign(settings, values)
				}),
			},
			postStateToWebview: vi.fn(),
		}
		return {
			task,
			provider,
			settings,
			handle: (payload = request) => handleAlwaysAllowReadOnlyAsk(provider as unknown as ClineProvider, payload),
		}
	}

	it("persists only Read and master, broadcasts settings and approves the exact pending ask", async () => {
		const { task, provider, settings, handle } = setup()
		await handle()
		expect(provider.contextProxy.setValues).toHaveBeenCalledWith({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
		})
		expect(settings).toEqual({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowAll: false,
			alwaysAllowWrite: false,
			alwaysAllowReadOnlyOutsideWorkspace: false,
		})
		expect(task.handleWebviewAskResponse).toHaveBeenCalledExactlyOnceWith("yesButtonClicked")
		expect(provider.postStateToWebview).toHaveBeenCalledOnce()
		expect(await checkAutoApproval({ state: settings, ask: "tool", text: task.clineMessages[0].text })).toEqual({
			decision: "approve",
		})
	})

	it("does not activate dormant All actions by enabling the master switch", async () => {
		const { task, provider, settings, handle } = setup()
		settings.alwaysAllowAll = true
		await handle()
		expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
		expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
	})

	it.each([{ taskId: "other" }, { instanceId: "reloaded" }, { revision: 1 }, { askTs: 9 }])(
		"ignores stale identity %j without saving permissions",
		async (change) => {
			const { task, provider, handle } = setup()
			await handle({ ...request, ...change })
			expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		},
	)

	it.each(["mandatory", "pendingMandatory", "answered", "outside", "write", "malformed"])(
		"rejects %s asks",
		async (reason) => {
			const { task, provider, handle } = setup()
			if (reason === "mandatory") task.modelOperationState.requiresToolApproval = true
			if (reason === "pendingMandatory") task.modelOperationState.approval = { approvalId: "approval" }
			if (reason === "answered") task.isPendingToolAsk.mockReturnValue(false)
			if (reason === "outside")
				task.clineMessages[0].text = JSON.stringify({ tool: "markdownify", isOutsideWorkspace: true })
			if (reason === "write") task.clineMessages[0].text = JSON.stringify({ tool: "newFileCreated" })
			if (reason === "malformed") task.clineMessages[0].text = "not json"
			await handle()
			expect(provider.contextProxy.setValues).not.toHaveBeenCalled()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		},
	)

	it.each(["task", "ask", "revision", "mandatory"])(
		"does not answer if %s changes during persistence",
		async (change) => {
			const { task, provider, handle } = setup()
			provider.contextProxy.setValues.mockImplementation(async () => {
				if (change === "task") provider.getCurrentTask.mockReturnValue({ ...task })
				if (change === "ask") task.isPendingToolAsk.mockReturnValue(false)
				if (change === "revision") task.modelOperationState.revision++
				if (change === "mandatory") task.modelOperationState.requiresToolApproval = true
			})
			await handle()
			expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
		},
	)

	it("does not approve when persistence fails", async () => {
		const { task, provider, handle } = setup()
		provider.contextProxy.setValues.mockRejectedValue(new Error("storage unavailable"))
		await expect(handle()).rejects.toThrow("storage unavailable")
		expect(task.handleWebviewAskResponse).not.toHaveBeenCalled()
	})
})
