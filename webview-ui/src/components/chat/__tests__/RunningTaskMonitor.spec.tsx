import { act, fireEvent, render, screen } from "@testing-library/react"
import type { RunningTaskInfo, ExtensionState } from "@roo-code/types"
import { RunningTaskCard, RunningTaskMonitor } from "../RunningTaskMonitor"
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

const task: RunningTaskInfo = {
	taskId: "task",
	instanceId: "instance",
	title: "Working task",
	startedAt: 1000,
	status: "running",
	background: false,
}
beforeEach(() => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	vi.setSystemTime(2000)
	state = { runningTask: task, commandActivities: [] }
})
afterEach(() => vi.useRealTimers())

it("starts compact, exposes attention status, and only runs timers while expanded", () => {
	state.runningTask = { ...task, status: "approval" }
	render(<RunningTaskMonitor />)
	const toggle = screen.getByRole("button", { expanded: false })
	expect(toggle).toHaveTextContent("chat:runningTask.status.approval")
	expect(screen.queryByText("Working task")).not.toBeInTheDocument()
	expect(vi.getTimerCount()).toBe(0)
	fireEvent.click(toggle)
	expect(screen.getByText("Working task")).toBeInTheDocument()
	expect(vi.getTimerCount()).toBe(1)
	fireEvent.click(screen.getByRole("button", { expanded: true }))
	expect(screen.queryByText("Working task")).not.toBeInTheDocument()
	expect(vi.getTimerCount()).toBe(0)
})

it("hides the empty monitor but keeps released commands accessible without a current task", () => {
	state = {}
	const { container, rerender } = render(<RunningTaskMonitor />)
	expect(container).toBeEmptyDOMElement()
	state.commandActivities = [
		{
			id: "cmd",
			terminalId: 1,
			command: "server",
			cwd: "/work",
			provider: "execa",
			startedAt: 1000,
			status: "running",
			canStop: false,
			canShowTerminal: false,
			outputTail: "",
		},
	]
	rerender(<RunningTaskMonitor />)
	expect(screen.getByRole("button", { expanded: false })).toHaveTextContent("(1/1)")
	fireEvent.click(screen.getByRole("button", { expanded: false }))
	expect(screen.getByText("server")).toBeInTheDocument()
})

it("backgrounds without sending clear or cancel, then correlates controls to a new child", () => {
	const { rerender } = render(<RunningTaskCard task={task} />)
	fireEvent.click(screen.getByText("chat:runningTask.background"))
	expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "backgroundTask",
		taskId: "task",
		instanceId: "instance",
	})
	rerender(
		<RunningTaskCard
			task={{ ...task, taskId: "child", instanceId: "child-instance", background: true, status: "approval" }}
		/>,
	)
	expect(screen.getByRole("status")).toHaveTextContent("chat:runningTask.status.approval")
	fireEvent.click(screen.getByText("chat:runningTask.return"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "foregroundTask",
		taskId: "child",
		instanceId: "child-instance",
	})
	fireEvent.click(screen.getByText("chat:runningTask.cancel"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "cancelBackgroundTask",
		taskId: "child",
		instanceId: "child-instance",
	})
})

it("counts approval wait time, freezes when stopped, and cleans up hidden timers", () => {
	const { rerender, unmount } = render(<RunningTaskCard task={{ ...task, status: "approval" }} />)
	expect(screen.getByText("00:00:01")).toBeInTheDocument()
	act(() => {
		vi.advanceTimersByTime(2000)
	})
	expect(screen.getByText("00:00:03")).toBeInTheDocument()
	rerender(<RunningTaskCard task={{ ...task, status: "completed", stoppedAt: 3500, background: true }} />)
	expect(screen.getByText("00:00:02")).toBeInTheDocument()
	expect(screen.queryByText("chat:runningTask.cancel")).not.toBeInTheDocument()
	expect(screen.getByText("chat:runningTask.return")).toBeInTheDocument()
	expect(vi.getTimerCount()).toBe(0)
	rerender(<RunningTaskCard task={task} visible={false} />)
	expect(vi.getTimerCount()).toBe(0)
	unmount()
})
