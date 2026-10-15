import { ClineProvider } from "../ClineProvider"
const operation = {
	operationId: "op",
	kind: "switch",
	taskId: "task",
	instanceId: "instance",
	revision: 3,
	profileId: "profile",
	confirmCurrentWorkspace: false,
}
function fixture() {
	const task = {
		taskId: "task",
		instanceId: "instance",
		modelOperationState: { revision: 3 },
		queueProfileForNextRequest: vi.fn(),
		isAssistantMessageEditing: false,
	}
	const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		getCurrentTask: () => task,
		isChatWindowFollowing: () => true,
		postMessageToWebview,
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		providerSettingsManager: {
			getProfile: vi.fn().mockResolvedValue({ id: "profile", name: "Other", apiProvider: "deepseek" }),
		},
		getState: vi.fn().mockResolvedValue({ organizationAllowList: { allowAll: true, providers: {} } }),
	})
	Object.defineProperty(provider, "isTaskBackgrounded", { value: false, configurable: true })
	return { provider, task, postMessageToWebview }
}
describe("model control acknowledgements", () => {
	it("rejects overlapping profile loads instead of applying them out of order", async () => {
		const { provider, task, postMessageToWebview } = fixture()
		let release!: (profile: object) => void
		provider.providerSettingsManager.getProfile.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const first = provider.queueTaskProfile(operation)
		await vi.waitFor(() => expect(provider.providerSettingsManager.getProfile).toHaveBeenCalledTimes(1))
		await provider.queueTaskProfile({ ...operation, operationId: "second" })
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: expect.objectContaining({ operationId: "second", status: "blocked" }),
		})
		release({ id: "profile", name: "Other", apiProvider: "deepseek" })
		await first
		expect(task.queueProfileForNextRequest).toHaveBeenCalledTimes(1)
	})
	it("posts the original operation ID on busy rejection", async () => {
		const { provider, postMessageToWebview } = fixture()
		provider.modelOperationInProgress = true
		await provider.handleModelOperation(operation)
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: expect.objectContaining({ operationId: "op", status: "blocked" }),
		})
	})
	it("posts the approval ID on background rejection", async () => {
		const { provider, postMessageToWebview } = fixture()
		Object.defineProperty(provider, "isTaskBackgrounded", { value: true })
		await provider.handleModelOperationApproval({ ...operation, approvalId: "approval" })
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: expect.objectContaining({ operationId: "approval", status: "blocked" }),
		})
	})
	it("queues a profile on the captured task without restarting or changing global settings", async () => {
		const { provider, task, postMessageToWebview } = fixture()
		await provider.queueTaskProfile(operation)
		expect(task.queueProfileForNextRequest).toHaveBeenCalledWith(
			"profile",
			"Other",
			expect.objectContaining({ apiProvider: "deepseek" }),
		)
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: expect.objectContaining({ operationId: "op", status: "completed" }),
		})
	})
	it("refuses the queue if the instance changes during profile loading", async () => {
		const { provider, task, postMessageToWebview } = fixture()
		provider.providerSettingsManager.getProfile.mockImplementation(async () => {
			provider.getCurrentTask = () => ({ ...task, instanceId: "replacement" })
			return { id: "profile", name: "Other", apiProvider: "deepseek" }
		})
		await provider.queueTaskProfile(operation)
		expect(task.queueProfileForNextRequest).not.toHaveBeenCalled()
		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "modelOperationStatus",
			modelOperationStatus: expect.objectContaining({ status: "blocked" }),
		})
	})
})
