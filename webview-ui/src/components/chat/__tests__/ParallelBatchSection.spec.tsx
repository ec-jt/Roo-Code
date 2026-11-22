import { fireEvent, render, screen } from "@testing-library/react"
import type { ExtensionState, ParallelBatchInfo } from "@roo-code/types"
import { RunningTaskMonitor } from "../RunningTaskMonitor"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
let state: Partial<ExtensionState>
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
}))

const batch: ParallelBatchInfo = {
	batchId: "batch-1",
	parentTaskId: "parent",
	concurrency: 2,
	tokenBudget: 2_000_000,
	usedTokens: 1_234,
	running: true,
	children: [
		{ taskId: "a", mode: "code", status: "running", requests: 3, cost: 0.0123, branch: "roo/subtask/a" },
		{ taskId: "b", mode: "debug", status: "budget-denied", requests: 1, cost: 0, branch: "roo/subtask/b" },
	],
}

beforeEach(() => {
	vi.clearAllMocks()
	state = { commandActivities: [], parallelBatch: batch }
})

const expand = () => fireEvent.click(screen.getByRole("button", { expanded: false }))

it("shows the monitor when only a parallel batch exists, and lists the children", () => {
	render(<RunningTaskMonitor />)
	expand()
	const section = screen.getByTestId("parallel-batch-section")
	expect(section).toHaveTextContent("chat:parallelSubtasks.title")
	const children = screen.getAllByTestId("parallel-child")
	expect(children).toHaveLength(2)
	expect(children[0]).toHaveTextContent("code")
	expect(children[0]).toHaveTextContent("chat:parallelSubtasks.status.running")
	expect(children[1]).toHaveTextContent("chat:parallelSubtasks.status.budget-denied")
	// Only the running child has a Stop button.
	expect(screen.getAllByText("chat:parallelSubtasks.stop")).toHaveLength(1)
	expect(screen.getAllByText("chat:parallelSubtasks.open")).toHaveLength(2)
})

it("Stop, Stop all and Open post parallelBatchControl", () => {
	render(<RunningTaskMonitor />)
	expand()
	fireEvent.click(screen.getByText("chat:parallelSubtasks.stop"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "parallelBatchControl",
		parallelBatchControl: { batchId: "batch-1", action: "stop", taskId: "a" },
	})
	fireEvent.click(screen.getByText("chat:parallelSubtasks.stopAll"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "parallelBatchControl",
		parallelBatchControl: { batchId: "batch-1", action: "stopAll" },
	})
	fireEvent.click(screen.getAllByText("chat:parallelSubtasks.open")[1])
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "parallelBatchControl",
		parallelBatchControl: { batchId: "batch-1", action: "open", taskId: "b" },
	})
})

it("hides Stop all once the batch has finished", () => {
	state.parallelBatch = {
		...batch,
		running: false,
		children: batch.children.map((c) => ({ ...c, status: "completed" })),
	}
	render(<RunningTaskMonitor />)
	expand()
	expect(screen.queryByText("chat:parallelSubtasks.stopAll")).toBeNull()
	expect(screen.queryByText("chat:parallelSubtasks.stop")).toBeNull()
})

it("stays hidden with no task, no commands and no batch", () => {
	state = { commandActivities: [], parallelBatch: null }
	const { container } = render(<RunningTaskMonitor />)
	expect(container).toBeEmptyDOMElement()
})
