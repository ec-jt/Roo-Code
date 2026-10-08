import { act, fireEvent, render, screen } from "@testing-library/react"
import type { CommandActivityInfo } from "@roo-code/types"
import { CommandActivityList } from "../CommandActivityList"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, values?: unknown) => key + (values ? JSON.stringify(values) : "") }),
}))
vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
		<button onClick={onClick}>{children}</button>
	),
}))

const activity: CommandActivityInfo = {
	id: "execution",
	terminalId: 1,
	taskId: "owner",
	command: "server",
	cwd: "/work",
	provider: "vscode",
	startedAt: 1000,
	status: "running",
	canStop: true,
	canShowTerminal: true,
	outputTail: "<script>plain text</script>",
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

it("shows ownership/output and sends execution-specific controls", () => {
	render(<CommandActivityList activities={[activity]} visible />)
	expect(screen.getByText(/owner.*owner/)).toBeInTheDocument()
	expect(screen.getByText("<script>plain text</script>")).toBeInTheDocument()
	fireEvent.click(screen.getByText("chat:backgroundActivity.stop"))
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "commandActivityControl",
		commandActivityControl: { id: "execution", action: "stop" },
	})
	fireEvent.click(screen.getByText("chat:backgroundActivity.show"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "commandActivityControl",
		commandActivityControl: { id: "execution", action: "show" },
	})
})
it("does not offer controls or an invented elapsed duration for unknown executions", () => {
	render(
		<CommandActivityList
			activities={[{ ...activity, status: "unknown", canStop: false, canShowTerminal: false }]}
			visible
		/>,
	)
	expect(screen.queryByRole("button")).not.toBeInTheDocument()
	expect(screen.queryByText(/backgroundActivity.elapsed/)).not.toBeInTheDocument()
})
it("ticks only while expanded/visible and freezes elapsed time on exit", () => {
	vi.useFakeTimers()
	vi.setSystemTime(2000)
	const { container, rerender } = render(<CommandActivityList activities={[activity]} visible />)
	const details = container.querySelector("details")!
	act(() => {
		details.open = true
		fireEvent(details, new Event("toggle"))
	})
	act(() => {
		vi.advanceTimersByTime(2000)
	})
	expect(screen.getByText(/backgroundActivity.elapsed/)).toHaveTextContent('"seconds":3')
	rerender(
		<CommandActivityList
			activities={[{ ...activity, status: "completed", endedAt: 3000, canStop: false }]}
			visible
		/>,
	)
	expect(screen.getByText(/backgroundActivity.elapsed/)).toHaveTextContent('"seconds":2')
})
