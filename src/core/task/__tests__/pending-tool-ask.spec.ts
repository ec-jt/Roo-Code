import { Task } from "../Task"

vi.mock("../../webview/ClineProvider")
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))

describe("Task.isPendingToolAsk", () => {
	const pending = () => ({
		abort: false,
		abandoned: false,
		modelOperationClosed: false,
		askResponse: undefined as string | undefined,
		lastMessageTs: 10,
		clineMessages: [{ ts: 10, type: "ask", ask: "tool", partial: false, isAnswered: false }],
	})
	const check = (task: ReturnType<typeof pending>, ts = 10) =>
		Task.prototype.isPendingToolAsk.call(task as unknown as Task, ts)

	it("accepts only the current full pending tool ask", () => {
		const task = pending()
		expect(check(task)).toBe(true)
		expect(check(task, 9)).toBe(false)
	})

	it.each(["yesButtonClicked", "noButtonClicked", "messageResponse"])(
		"never overwrites an existing %s response",
		(response) => {
			const task = pending()
			task.askResponse = response
			expect(check(task)).toBe(false)
		},
	)

	it.each(["abort", "abandoned", "modelOperationClosed"] as const)("rejects %s tasks", (flag) => {
		const task = pending()
		task[flag] = true
		expect(check(task)).toBe(false)
	})

	it.each(["partial", "isAnswered"] as const)("rejects %s messages", (flag) => {
		const task = pending()
		task.clineMessages[0][flag] = true
		expect(check(task)).toBe(false)
	})

	it("rejects superseded asks and non-tool messages", () => {
		const task = pending()
		task.lastMessageTs = 11
		expect(check(task)).toBe(false)
		task.lastMessageTs = 10
		task.clineMessages[0].ask = "followup"
		expect(check(task)).toBe(false)
		task.clineMessages = []
		expect(check(task)).toBe(false)
	})
})
