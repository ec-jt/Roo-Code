import { useState } from "react"
import { act, fireEvent, render, screen, within } from "@src/utils/test-utils"
import type { ClineMessage, ModelOperationState, ModelOperationStatus } from "@roo-code/types"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { ChatTextArea } from "../ChatTextArea"
import { ModelOperationPanel, ModelOperationProvider, RegenerateWithModel } from "../ModelOperationContext"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, options?: { tool?: string }) => (options?.tool ? `${key}: ${options.tool}` : key),
	}),
}))
vi.mock("../ApiConfigSelector", () => ({
	ApiConfigSelector: ({
		onChange,
		disabled,
		displayName,
	}: {
		onChange: (value: string) => void
		disabled: boolean
		displayName: string
	}) => (
		<button disabled={disabled} onClick={() => onChange("target-profile")}>
			Select profile {displayName}
		</button>
	),
}))

const source: ModelOperationState = {
	taskId: "source",
	instanceId: "instance",
	revision: 7,
	requestId: "live-request",
	readiness: "ready",
	requiresToolApproval: false,
}
const assistant: ClineMessage = {
	ts: 12,
	type: "say",
	say: "text",
	text: "Saved answer",
	requestId: "historical-request",
}
let state: ModelOperationState | undefined
let profiles: { id: string; name: string }[]
const emptyList: never[] = []
const emptyConfiguration = {}

function Harness({ message = assistant, streaming = true }: { message?: ClineMessage; streaming?: boolean }) {
	const [draft, setDraft] = useState("Keep my unsent draft")
	return (
		<ModelOperationProvider>
			<RegenerateWithModel message={message} />
			<ModelOperationPanel />
			<ChatTextArea
				inputValue={draft}
				setInputValue={setDraft}
				sendingDisabled={true}
				selectApiConfigDisabled={true}
				placeholderText="Draft"
				selectedImages={[]}
				setSelectedImages={vi.fn()}
				onSend={vi.fn()}
				onSelectImages={vi.fn()}
				shouldDisableImages={false}
				mode="code"
				setMode={vi.fn()}
				modeShortcutText=""
				isStreaming={streaming}
			/>
		</ModelOperationProvider>
	)
}

const regenerate = "chat:modelOperation.regenerate"
const switchLabel = "chat:modelOperation.switch"
const postStatus = (status: ModelOperationStatus) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "modelOperationStatus", modelOperationStatus: status } }),
		)
	})
const operations = () =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.type === "modelOperation")
const approvals = () =>
	vi
		.mocked(vscode.postMessage)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.type === "modelOperationApproval")
function confirm(label: string) {
	const dialog = within(screen.getByRole("dialog"))
	fireEvent.click(dialog.getByRole("checkbox"))
	fireEvent.click(dialog.getByRole("button", { name: label }))
}

beforeEach(() => {
	vi.clearAllMocks()
	state = { ...source }
	profiles = [
		{ id: "target-profile", name: "Saved target" },
		{ id: "other", name: "Other" },
	]
	vi.mocked(useExtensionState).mockImplementation(
		() =>
			({
				modelOperation: state,
				listApiConfigMeta: profiles,
				currentApiConfigName: "Saved target",
				filePaths: emptyList,
				openedTabs: emptyList,
				taskHistory: emptyList,
				clineMessages: emptyList,
				cwd: "/workspace",
				apiConfiguration: emptyConfiguration,
			}) as unknown as ReturnType<typeof useExtensionState>,
	)
})

it("requires explicit workspace confirmation and dispatches the historical request with exact identity", () => {
	state = { ...source, readiness: "blocked", reason: "Tools were already executed" }
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	const dialog = within(screen.getByRole("dialog"))
	expect(dialog.getByText("chat:modelOperation.warning")).toBeInTheDocument()
	expect(dialog.getByRole("combobox")).toHaveAccessibleName("chat:modelOperation.profile")
	expect(dialog.getByRole("button", { name: regenerate })).toBeDisabled()
	expect(operations()).toHaveLength(0)
	confirm(regenerate)
	expect(operations()).toEqual([
		{
			type: "modelOperation",
			modelOperation: {
				operationId: expect.any(String),
				kind: "regenerate",
				taskId: "source",
				instanceId: "instance",
				revision: 7,
				profileId: "target-profile",
				requestId: "historical-request",
				confirmCurrentWorkspace: true,
			},
		},
	])
	expect(screen.getByPlaceholderText("Draft")).toHaveValue("Keep my unsent draft")
})

it("enables the generating selector but never loads global configuration; cancellation preserves draft", () => {
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: /Select profile/ }))
	expect(operations()).toHaveLength(0)
	fireEvent.click(screen.getByRole("button", { name: "chat:modelOperation.cancel" }))
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	expect(operations()).toHaveLength(0)
	fireEvent.click(screen.getByRole("button", { name: /Select profile/ }))
	confirm(switchLabel)
	expect(operations()[0].modelOperation).toMatchObject({
		kind: "switch",
		requestId: "live-request",
		profileId: "target-profile",
	})
	expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "loadApiConfigurationById" }))
	expect(screen.getByPlaceholderText("Draft")).toHaveValue("Keep my unsent draft")
})

it("shows live readiness reason and cannot switch when blocked", () => {
	state = { ...source, readiness: "blocked", reason: "A tool has been admitted" }
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: /Select profile/ }))
	expect(screen.getByRole("alert")).toHaveTextContent("A tool has been admitted")
	confirm(switchLabel)
	expect(operations()).toHaveLength(0)
})

it.each(["revision", "instanceId", "taskId"] as const)("invalidates the dialog when %s changes", (field) => {
	const view = render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	state = { ...source, [field]: field === "revision" ? 8 : "replacement" }
	view.rerender(<Harness />)
	expect(screen.getByRole("alert")).toHaveTextContent("chat:modelOperation.stale")
	confirm(regenerate)
	expect(operations()).toHaveLength(0)
})

it("disables legacy responses with an explicit reason", () => {
	render(<Harness message={{ ...assistant, requestId: undefined }} />)
	expect(screen.getByRole("button", { name: regenerate })).toBeDisabled()
	expect(screen.getByText("chat:modelOperation.legacy")).toBeInTheDocument()
})

it("does not offer regeneration for partial assistant text", () => {
	render(<Harness message={{ ...assistant, partial: true }} />)
	expect(screen.queryByRole("button", { name: regenerate })).not.toBeInTheDocument()
})

it("cannot dispatch without a saved profile", () => {
	profiles = []
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	expect(screen.getByText("chat:modelOperation.noProfiles")).toBeInTheDocument()
	confirm(regenerate)
	expect(operations()).toHaveLength(0)
})

it("allows choosing a different saved profile in the regeneration dialog", () => {
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
	fireEvent.click(screen.getByRole("option", { name: "Other" }))
	confirm(regenerate)
	expect(operations()[0].modelOperation?.profileId).toBe("other")
})

it("uses the branch-pinned profile instead of the globally selected profile", () => {
	state = { ...source, profileId: "other" }
	render(<Harness />)
	expect(screen.getByRole("button", { name: "Select profile Other" })).toBeInTheDocument()
})

it("ignores a status after the source advances to a different request", () => {
	const view = render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	confirm(regenerate)
	const operationId = operations()[0].modelOperation!.operationId
	state = { ...source, revision: source.revision + 2, requestId: "next-request" }
	view.rerender(<Harness />)
	postStatus({ operationId, status: "failed", message: "Stale operation" })
	expect(screen.queryByText("Stale operation")).not.toBeInTheDocument()
	expect(screen.getByRole("button", { name: regenerate })).toBeEnabled()
})

it("allows retrying an explicitly blocked approval and correlates by approval ID", () => {
	state = { ...source, requiresToolApproval: true, approval: { approvalId: "approval", toolName: "read_file" } }
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: "chat:approve.title" }))
	postStatus({
		operationId: "approval",
		status: "blocked",
		message: "Refresh approval",
		taskId: source.taskId,
		instanceId: source.instanceId,
		revision: source.revision,
	})
	expect(screen.getByRole("alert")).toHaveTextContent("Refresh approval")
	fireEvent.click(screen.getByRole("button", { name: "chat:reject.title" }))
	expect(approvals()).toHaveLength(2)
})

it.each(["blocked", "failed"] as const)("displays %s status and ignores unrelated or late updates", (status) => {
	render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: regenerate }))
	confirm(regenerate)
	const operationId = operations()[0].modelOperation!.operationId
	postStatus({ operationId: "unrelated", status: "failed", message: "Wrong operation" })
	expect(screen.queryByText("Wrong operation")).not.toBeInTheDocument()
	postStatus({ operationId, status, message: "Backend explanation" })
	expect(screen.getByRole("alert")).toHaveTextContent("Backend explanation")
	postStatus({ operationId, status: "running", message: "Late progress" })
	expect(screen.queryByText("Late progress")).not.toBeInTheDocument()
})

it.each([true, false])("reconciles branch activation with state-first=%s and preserves draft", (stateFirst) => {
	const view = render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: /Select profile/ }))
	confirm(switchLabel)
	const operationId = operations()[0].modelOperation!.operationId
	const branch = { ...source, taskId: "branch", instanceId: "branch-instance", revision: 9 }
	const completion: ModelOperationStatus = {
		operationId,
		status: "completed",
		message: "Branch activated, response still generating",
		taskId: branch.taskId,
		instanceId: branch.instanceId,
		revision: branch.revision,
	}
	if (stateFirst) {
		state = branch
		view.rerender(<Harness />)
	}
	postStatus(completion)
	if (!stateFirst) {
		state = branch
		view.rerender(<Harness />)
	}
	expect(screen.getByRole("status")).toHaveTextContent(completion.message)
	expect(screen.getByPlaceholderText("Draft")).toHaveValue("Keep my unsent draft")
	state = { ...branch, taskId: "unrelated", instanceId: "unrelated-instance" }
	view.rerender(<Harness />)
	expect(screen.queryByText(completion.message)).not.toBeInTheDocument()
})

it.each([true, false])("requires explicit tool approval (approved=%s) bound to the branch identity", (approved) => {
	state = {
		...source,
		requiresToolApproval: true,
		approval: { approvalId: "approval-1", toolName: "execute_command" },
	}
	render(<Harness />)
	expect(approvals()).toHaveLength(0)
	expect(screen.getByText(/execute_command/)).toBeInTheDocument()
	fireEvent.click(screen.getByRole("button", { name: approved ? "chat:approve.title" : "chat:reject.title" }))
	expect(approvals()).toEqual([
		{
			type: "modelOperationApproval",
			modelOperationApproval: {
				taskId: "source",
				instanceId: "instance",
				revision: 7,
				approvalId: "approval-1",
				approved,
			},
		},
	])
	expect(screen.getByRole("button", { name: "chat:approve.title" })).toBeDisabled()
	expect(screen.getByRole("button", { name: "chat:reject.title" })).toBeDisabled()
	postStatus({
		operationId: "approval-1",
		status: "completed",
		message: "Approval response accepted",
		taskId: "source",
		instanceId: "instance",
		revision: 7,
	})
	expect(screen.getByRole("status")).toHaveTextContent("Approval response accepted")
	expect(screen.getByPlaceholderText("Draft")).toHaveValue("Keep my unsent draft")
})

it("replaces stale approval identity and ignores the previous approval result", () => {
	state = { ...source, requiresToolApproval: true, approval: { approvalId: "old", toolName: "read_file" } }
	const view = render(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: "chat:approve.title" }))
	state = {
		...source,
		revision: 8,
		requiresToolApproval: true,
		approval: { approvalId: "new", toolName: "write_file" },
	}
	view.rerender(<Harness />)
	fireEvent.click(screen.getByRole("button", { name: "chat:reject.title" }))
	expect(approvals()[1].modelOperationApproval).toMatchObject({ revision: 8, approvalId: "new", approved: false })
	postStatus({
		operationId: "old",
		status: "blocked",
		message: "Old rejection",
		taskId: "source",
		instanceId: "instance",
		revision: 7,
	})
	expect(screen.queryByText("Old rejection")).not.toBeInTheDocument()
})
