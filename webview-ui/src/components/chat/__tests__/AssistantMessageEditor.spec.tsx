import { act, fireEvent, render, screen } from "@/utils/test-utils"
import type { ClineMessage, AssistantMessageEdit } from "@roo-code/types"
import { AssistantMessageEditor } from "../AssistantMessageEditor"
import { vscode } from "@/utils/vscode"

const { state } = vi.hoisted(() => ({ state: { current: {} as any } }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state.current }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const message: ClineMessage = { ts: 2, type: "say", say: "text", text: "Original assistant text" }
const reply = (request: AssistantMessageEdit, success: boolean, error?: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "assistantMessageEditResult",
					assistantMessageEditResult: { ...request, success, error },
				},
			}),
		)
	})
const open = () => {
	fireEvent.click(screen.getByRole("button", { name: "Edit assistant response" }))
	fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited assistant text" } })
}

describe("assistant history editor", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		state.current = {
			chatWindow: { taskId: "task", instanceId: "instance", following: true, truncatedTs: [] },
			clineMessages: [{ ts: 1 }, message],
		}
	})
	it("sends a correlated history edit, not a user message, and waits for acknowledgement", () => {
		render(<AssistantMessageEditor message={message} isStreaming={false} />)
		open()
		fireEvent.click(screen.getByRole("button", { name: "Save without running" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		const sent = vi.mocked(vscode.postMessage).mock.calls[0][0]
		expect(sent).toEqual({
			type: "editAssistantMessage",
			assistantMessageEdit: {
				operationId: expect.any(String),
				taskId: "task",
				instanceId: "instance",
				ts: 2,
				expectedText: message.text,
				text: "Edited assistant text",
			},
		})
		expect(screen.getByRole("textbox")).toBeDisabled()
		reply({ ...sent.assistantMessageEdit!, instanceId: "stale" }, true)
		expect(screen.getByRole("textbox")).toBeInTheDocument()
		reply(sent.assistantMessageEdit!, true)
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("Saved. Nothing was run.")
	})
	it("keeps the draft on a rejected save", () => {
		render(<AssistantMessageEditor message={message} isStreaming={false} />)
		open()
		fireEvent.click(screen.getByRole("button", { name: "Save without running" }))
		reply(
			vi.mocked(vscode.postMessage).mock.calls[0][0].assistantMessageEdit!,
			false,
			"Stop the active request first",
		)
		expect(screen.getByRole("textbox")).toHaveValue("Edited assistant text")
		expect(screen.getByRole("alert")).toHaveTextContent("Stop the active request first")
	})
	it("blocks stale text instead of overwriting a newer response", () => {
		const { rerender } = render(<AssistantMessageEditor message={message} isStreaming={false} />)
		open()
		rerender(<AssistantMessageEditor message={{ ...message, text: "Changed elsewhere" }} isStreaming={false} />)
		expect(screen.getByRole("button", { name: "Save without running" })).toBeDisabled()
		expect(screen.getByRole("textbox")).toHaveValue("Edited assistant text")
	})
	it.each(["historical", "background", "root", "preview", "streaming", "partial", "tool"])(
		"hides controls for %s",
		(kind) => {
			if (kind === "historical") state.current.chatWindow.following = false
			if (kind === "background") state.current.runningTask = { background: true }
			if (kind === "root") state.current.clineMessages = [message]
			if (kind === "preview") state.current.chatWindow.truncatedTs = [2]
			render(
				<AssistantMessageEditor
					message={{ ...message, partial: kind === "partial", say: kind === "tool" ? "tool" : "text" }}
					isStreaming={kind === "streaming"}
				/>,
			)
			expect(screen.queryByRole("button")).not.toBeInTheDocument()
		},
	)
	it("preserves the draft on timeout without silently retrying", () => {
		vi.useFakeTimers()
		try {
			render(<AssistantMessageEditor message={message} isStreaming={false} />)
			open()
			fireEvent.click(screen.getByRole("button", { name: "Save without running" }))
			act(() => vi.advanceTimersByTime(30_000))
			expect(screen.getByRole("alert")).toHaveTextContent("acknowledgement was not received")
			expect(screen.getByRole("textbox")).toHaveValue("Edited assistant text")
			expect(screen.getByRole("button", { name: "Save without running" })).toBeDisabled()
			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})
})
