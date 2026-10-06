import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { BraveWebSearchTool } from "../BraveWebSearchTool"
import { BraveLocalSearchTool } from "../BraveLocalSearchTool"
import { braveSearch } from "../../../services/native-tools/brave"

vi.mock("../../../services/native-tools/brave", () => ({
	braveSearch: vi.fn().mockResolvedValue({}),
	formatBraveWebSearchResponse: () => "web results",
	formatBraveLocalSearchResponse: () => "local results",
}))

describe.each([new BraveWebSearchTool(), new BraveLocalSearchTool()])("$name credentials", (tool) => {
	let state: { braveApiKey?: string }
	let task: Task
	let callbacks: ToolCallbacks
	beforeEach(() => {
		vi.clearAllMocks()
		state = {}
		task = {
			providerRef: { deref: () => ({ getState: async () => state }) },
			say: vi.fn(),
			didToolFailInCurrentTurn: false,
			consecutiveMistakeCount: 0,
		} as unknown as Task
		callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			handleError: vi.fn(),
		} as unknown as ToolCallbacks
	})

	it.each([undefined, "", " \t\n "])(
		"rejects a stale call with missing key %j before approval or network",
		async (key) => {
			state.braveApiKey = key
			await tool.execute({ query: "test" }, task, callbacks)
			expect(task.say).toHaveBeenCalledWith("error", expect.stringContaining("API key is not configured"))
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(braveSearch).not.toHaveBeenCalled()
		},
	)

	it("uses a trimmed key only after approval", async () => {
		state.braveApiKey = " test-key "
		await tool.execute({ query: "test" }, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(vi.mocked(braveSearch).mock.calls[0][0]).toBe("test-key")
		expect(vi.mocked(callbacks.askApproval).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(braveSearch).mock.invocationCallOrder[0],
		)
	})

	it("does not request results when approval is denied", async () => {
		state.braveApiKey = "test-key"
		vi.mocked(callbacks.askApproval).mockResolvedValue(false)
		await tool.execute({ query: "test" }, task, callbacks)
		expect(braveSearch).not.toHaveBeenCalled()
	})
})
