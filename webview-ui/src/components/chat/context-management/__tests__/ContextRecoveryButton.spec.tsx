import { fireEvent, render, screen } from "@testing-library/react"
import { ContextRecoveryButton } from "../ContextRecoveryButton"
import { vscode } from "@/utils/vscode"

const state = vi.hoisted(() => ({
	chatWindow: { taskId: "parent", instanceId: "instance", following: false },
	runningTask: { background: false },
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

describe("context recovery action", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.runningTask.background = false
	})
	it("requests a separate branch from the exact event even on historical pages", () => {
		render(<ContextRecoveryButton eventId="event" />)
		fireEvent.click(screen.getByRole("button", { name: "Recover in new branch…" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "contextRecoveryBranch",
			contextRecoveryBranch: { taskId: "parent", instanceId: "instance", eventId: "event" },
		})
	})
	it("hides the action for a background task", () => {
		state.runningTask.background = true
		render(<ContextRecoveryButton eventId="event" />)
		expect(screen.queryByRole("button")).toBeNull()
	})
})
