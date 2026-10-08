import * as vscode from "vscode"
import { ClineProvider } from "../ClineProvider"
import { CommandActivity } from "../../../integrations/terminal/CommandActivity"

vi.mock("../../../integrations/terminal/CommandActivity", () => ({
	CommandActivity: { stop: vi.fn(), showTerminal: vi.fn() },
}))
const activity = { id: "execution", canStop: true }
const makeProvider = () => ({
	_disposed: false,
	getCommandActivities: vi.fn(() => [activity]),
	postMessageToWebview: vi.fn(),
})
beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.restoreAllMocks())

it("refuses activity outside the provider scope", async () => {
	const provider = makeProvider()
	await ClineProvider.prototype.handleCommandActivityControl.call(provider as never, { id: "other", action: "stop" })
	expect(CommandActivity.stop).not.toHaveBeenCalled()
})
it("requires confirmation and rechecks scope after the dialog", async () => {
	const provider = makeProvider()
	provider.getCommandActivities.mockReturnValueOnce([activity]).mockReturnValue([])
	vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Stop command" as never)
	await ClineProvider.prototype.handleCommandActivityControl.call(provider as never, {
		id: "execution",
		action: "stop",
	})
	expect(CommandActivity.stop).not.toHaveBeenCalled()
})
it("stops only the confirmed execution and shows only a scoped terminal", async () => {
	const provider = makeProvider()
	vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Stop command" as never)
	await ClineProvider.prototype.handleCommandActivityControl.call(provider as never, {
		id: "execution",
		action: "stop",
	})
	expect(CommandActivity.stop).toHaveBeenCalledExactlyOnceWith("execution")
	await ClineProvider.prototype.handleCommandActivityControl.call(provider as never, {
		id: "execution",
		action: "show",
	})
	expect(CommandActivity.showTerminal).toHaveBeenCalledExactlyOnceWith("execution")
})
