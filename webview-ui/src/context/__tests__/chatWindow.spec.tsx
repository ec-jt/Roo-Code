import { act, render, screen } from "@/utils/test-utils"
import type { ChatWindowState, ExtensionState } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { ExtensionStateContextProvider, mergeExtensionState, useExtensionState } from "../ExtensionStateContext"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

export const windowState = (sequence = 1): ChatWindowState => ({
	taskId: "task",
	instanceId: "instance",
	revision: 4,
	sequence,
	startIndex: 101,
	endIndex: 201,
	totalMessages: 201,
	hasOlder: true,
	hasNewer: false,
	following: true,
	summary: {
		tokenUsage: { totalTokensIn: 12345, totalTokensOut: 456, totalCost: 7, contextTokens: 890 },
		files: [],
		filesOmitted: 0,
	},
	truncatedTs: [],
	byteLength: 100,
})

const base = {
	clineMessages: [{ ts: 1, type: "say", say: "text", text: "root" }],
	chatWindow: windowState(),
	clineMessagesSeq: 1,
} as ExtensionState

describe("bounded chat state", () => {
	it("replaces pages without accumulating rows and retains omitted fields", () => {
		const messages = [
			{ ts: 1, type: "say" as const },
			{ ts: 200, type: "say" as const },
		]
		const next = mergeExtensionState(base, {
			clineMessages: messages,
			chatWindow: windowState(2),
			clineMessagesSeq: 2,
		})
		expect(next.clineMessages).toBe(messages)
		expect(mergeExtensionState(next, { version: "new" }).chatWindow).toBe(next.chatWindow)
	})
	it("rejects late pages and task swaps as an entire snapshot", () => {
		const current = mergeExtensionState(base, {
			chatWindow: { ...windowState(3), taskId: "new", instanceId: "new-instance" },
			clineMessagesSeq: 3,
			currentTaskId: "new",
			clineMessages: [],
		})
		expect(mergeExtensionState(current, { ...base, currentTaskId: "task" })).toBe(current)
		expect(mergeExtensionState(current, { chatWindow: windowState(2) })).toBe(current)
		expect(mergeExtensionState(current, { clineMessagesSeq: 2, currentTaskId: "old" })).toBe(current)
	})
	it("rejects unscoped legacy rows and accepts explicit clears", () => {
		expect(
			mergeExtensionState(base, { clineMessages: [{ ts: 999, type: "ask", ask: "command" }] }).clineMessages,
		).toBe(base.clineMessages)
		expect(mergeExtensionState(base, { clineMessages: [], clineMessagesSeq: 2 }).chatWindow).toBeUndefined()
	})
	it("acks received before commit, rendered after commit, and ignores legacy updates", () => {
		const frames: FrameRequestCallback[] = []
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frames.push(callback)
			return frames.length
		})
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
		function Probe() {
			const state = useExtensionState()
			return (
				<div data-testid="snapshot">
					{state.clineMessages[0]?.text}:{String(state.showWelcome)}
				</div>
			)
		}
		render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)
		const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data }))
		act(() => {
			send({ type: "state", state: { apiConfiguration: { apiProvider: "anthropic", apiKey: "test" } } })
			send({ type: "state", state: base })
			expect(vscode.postMessage).toHaveBeenCalledWith(
				expect.objectContaining({ chatWindowAck: expect.objectContaining({ phase: "received" }) }),
			)
			expect(vscode.postMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ chatWindowAck: expect.objectContaining({ phase: "rendered" }) }),
			)
		})
		expect(screen.getByTestId("snapshot")).toHaveTextContent("root:false")
		act(() => frames.forEach((frame) => frame(0)))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatWindowAck",
			chatWindowAck: { taskId: "task", instanceId: "instance", sequence: 1, phase: "rendered" },
		})
		act(() => send({ type: "messageUpdated", clineMessage: { ...base.clineMessages[0], text: "unbounded" } }))
		expect(screen.getByTestId("snapshot")).toHaveTextContent("root:false")
		vi.restoreAllMocks()
	})
})
