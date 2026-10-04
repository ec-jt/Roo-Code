import { fireEvent, render, screen } from "@testing-library/react"
import type { ClineMessage, ExtensionState } from "@roo-code/types"
import { AlwaysAllowReadOnlyButton } from "../AlwaysAllowReadOnlyButton"
import { vscode } from "@src/utils/vscode"

let state: Partial<ExtensionState>
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const ask: ClineMessage = {
	ts: 10,
	type: "ask",
	ask: "tool",
	text: JSON.stringify({ tool: "markdownify", url: "https://openvdn.github.io" }),
}

beforeEach(() => {
	vi.clearAllMocks()
	state = {
		currentTaskId: "task",
		modelOperation: {
			taskId: "task",
			instanceId: "instance",
			revision: 2,
			readiness: "ready",
			requiresToolApproval: false,
		},
	}
})

it("posts a single correlated category action, not a blanket setting change or unscoped approval", () => {
	render(<AlwaysAllowReadOnlyButton message={ask} />)
	fireEvent.click(screen.getByRole("button", { name: "settings:autoApprove.readOnly.alwaysAllow" }))
	expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "alwaysAllowReadOnlyAsk",
		alwaysAllowReadOnlyAsk: { taskId: "task", instanceId: "instance", revision: 2, askTs: 10 },
	})
})

it.each([
	"mandatory",
	"approval",
	"wrongTask",
	"missingOperation",
	"outside",
	"partial",
	"answered",
	"write",
	"dormantAll",
])("hides persistent permission for %s", (reason) => {
	const message = { ...ask }
	if (reason === "dormantAll") {
		state.autoApprovalEnabled = false
		state.alwaysAllowAll = true
	}
	if (reason === "mandatory") state.modelOperation!.requiresToolApproval = true
	if (reason === "approval") state.modelOperation!.approval = { approvalId: "approval", toolName: "markdownify" }
	if (reason === "wrongTask") state.currentTaskId = "other"
	if (reason === "missingOperation") state.modelOperation = undefined
	if (reason === "outside")
		message.text = JSON.stringify({ tool: "markdownify", path: "../secret", isOutsideWorkspace: true })
	if (reason === "partial") message.partial = true
	if (reason === "answered") message.isAnswered = true
	if (reason === "write") message.text = JSON.stringify({ tool: "newFileCreated" })
	render(<AlwaysAllowReadOnlyButton message={message} />)
	expect(screen.queryByRole("button")).not.toBeInTheDocument()
})
