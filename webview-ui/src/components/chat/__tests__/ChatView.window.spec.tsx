import React from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"
import type { ChatWindowState, ClineMessage } from "@roo-code/types"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import ChatView, { type ChatViewRef } from "../ChatView"
import { getApiMetrics } from "@roo/getApiMetrics"
import { fileChangesFromMessages } from "../utils/fileChangesFromMessages"
import { PlainHistoryMessage } from "../ChatWindowControls"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@roo/getApiMetrics", () => ({
	getApiMetrics: vi.fn(() => ({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 })),
}))
vi.mock("../utils/fileChangesFromMessages", () => ({ fileChangesFromMessages: vi.fn(() => []) }))
vi.mock("use-sound", () => ({ default: () => [vi.fn()] }))
vi.mock("../ChatRow", () => ({
	default: ({ message }: { message: ClineMessage }) => <div data-testid="legacy-row">{message.text}</div>,
}))
vi.mock("../TaskHeader", () => ({
	default: (props: any) => (
		<div data-testid="totals">
			{props.tokensIn}:{props.totalCost}:{props.contextTokens}
		</div>
	),
}))
vi.mock("../RunningTaskMonitor", () => ({ RunningTaskMonitor: () => <div data-testid="monitor" /> }))
vi.mock("../ChatTextArea", () => ({
	ChatTextArea: React.forwardRef((props: any, ref: React.ForwardedRef<HTMLTextAreaElement>) => (
		<div>
			<textarea
				ref={ref}
				aria-label="Draft"
				value={props.inputValue}
				onChange={(event) => props.setInputValue(event.target.value)}
			/>
			<button onClick={props.onSend}>Send</button>
			<button onClick={props.onEnqueueMessage}>Queue</button>
			<span data-testid="images">{props.selectedImages.length}</span>
		</div>
	)),
}))
vi.mock("react-virtuoso", () => ({
	Virtuoso: React.forwardRef(({ data, itemContent }: any, ref) => {
		React.useImperativeHandle(ref, () => ({ scrollToIndex: vi.fn() }))
		return (
			<div>
				{data.map((message: ClineMessage, index: number) => (
					<React.Fragment key={message.ts}>{itemContent(index, message)}</React.Fragment>
				))}
			</div>
		)
	}),
}))

const root: ClineMessage = { ts: 1, type: "say", say: "text", text: "Task" }
const live: ClineMessage = { ts: 202, type: "ask", ask: "followup", text: "Continue?" }
const page = (sequence: number, following = true): ChatWindowState => ({
	taskId: "task",
	instanceId: "instance",
	revision: 8,
	sequence,
	startIndex: following ? 101 : 1,
	endIndex: following ? 201 : 101,
	totalMessages: 201,
	hasOlder: following,
	hasNewer: !following,
	following,
	truncatedTs: [],
	byteLength: 100,
	liveMessage: following ? live : undefined,
	summary: {
		tokenUsage: { totalTokensIn: 12345, totalTokensOut: 456, totalCost: 7, contextTokens: 890 },
		files: [{ path: "changed.ts", added: 3, removed: 2, changes: 5 }],
		filesOmitted: 2,
	},
})
const push = (window: ChatWindowState, rows: ClineMessage[]) =>
	act(() =>
		globalThis.window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "state",
					state: { clineMessages: [root, ...rows], chatWindow: window, clineMessagesSeq: window.sequence },
				},
			}),
		),
	)

describe("bounded chat view", () => {
	beforeEach(() => vi.clearAllMocks())
	it("hides empty command status entries instead of offering a blank document", () => {
		const { container } = render(
			<PlainHistoryMessage message={{ ts: 2, type: "ask", ask: "command_output", text: "" }} window={page(1)} />,
		)
		expect(container).toBeEmptyDOMElement()
	})
	it("labels truncated tools without parsing incomplete JSON and opens the exact indexed row", () => {
		const row: ClineMessage = {
			ts: 2,
			type: "ask",
			ask: "tool",
			text: '{"tool":"readFile","content":"unfinished',
			chatPreview: { index: 12, truncated: true, label: "readFile", hasContent: true },
		}
		render(<PlainHistoryMessage message={row} window={page(1)} />)
		expect(screen.getByText("readFile (preview)")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Open full message" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatMessageOpen",
			chatMessageOpen: { taskId: "task", instanceId: "instance", ts: 2, index: 12, revision: 8 },
		})
	})
	it("keeps nonempty command-output asks collapsed and expandable", () => {
		render(
			<PlainHistoryMessage
				message={{ ts: 2, type: "ask", ask: "command_output", text: "stored output" }}
				window={page(1)}
			/>,
		)
		expect(screen.queryByText("stored output")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show preview" }))
		expect(screen.getByText("stored output")).toBeInTheDocument()
	})
	it("hides tool previews until explicitly expanded", () => {
		const message: ClineMessage = { ts: 2, type: "say", say: "command_output", text: "one\ntwo\nthree" }
		const { container } = render(<PlainHistoryMessage message={message} window={page(1)} />)
		expect(container.querySelector("pre")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Show preview" }))
		expect(container.querySelector("pre")).toHaveTextContent("one")
		fireEvent.click(screen.getByRole("button", { name: "Hide preview" }))
		expect(container.querySelector("pre")).toBeNull()
	})
	it("does not compact a live unanswered tool approval", () => {
		const message: ClineMessage = { ts: 2, type: "ask", ask: "tool", text: "approval details" }
		const { container } = render(
			<PlainHistoryMessage message={message} window={{ ...page(1), liveMessage: message }} />,
		)
		expect(container.querySelector("pre")).toHaveTextContent("approval details")
		expect(screen.queryByRole("button", { name: "Show preview" })).not.toBeInTheDocument()
	})
	it("uses full-history summaries without scanning and requests native stored diffs", () => {
		render(
			<ExtensionStateContextProvider>
				<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => {}} />
			</ExtensionStateContextProvider>,
		)
		vi.mocked(getApiMetrics).mockClear()
		push(page(1), [live])
		expect(screen.getByTestId("totals")).toHaveTextContent("12345:7:890")
		expect(getApiMetrics).not.toHaveBeenCalled()
		expect(fileChangesFromMessages).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("1 file(s) changed in this conversation"))
		fireEvent.click(screen.getByText("Open stored diffs"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatFileChangesOpen",
			chatFileChangesOpen: { taskId: "task", instanceId: "instance", path: "changed.ts" },
		})
	})
	it("renders malformed tool, command, API and browser previews only as plain text", () => {
		render(
			<ExtensionStateContextProvider>
				<ChatView isHidden={false} showAnnouncement={false} hideAnnouncement={() => {}} />
			</ExtensionStateContextProvider>,
		)
		const previews: ClineMessage[] = [
			{ ts: 2, type: "ask", ask: "tool" },
			{ ts: 3, type: "ask", ask: "use_mcp_server" },
			{ ts: 4, type: "say", say: "api_req_started" },
			{ ts: 5, type: "say", say: "browser_action_result" },
			{ ts: 6, type: "say", say: "command_output" },
		]
		const rows = previews.map((message) => ({ ...message, text: '{"incomplete":"' + "x".repeat(16000) }))
		const parse = vi.spyOn(JSON, "parse")
		push({ ...page(1), truncatedTs: rows.map((row) => row.ts) }, rows)
		expect(screen.getAllByTestId("plain-history-message")).toHaveLength(5)
		expect(screen.queryByTestId("legacy-row")).not.toBeInTheDocument()
		expect(parse.mock.calls.some(([text]) => text === rows[0].text)).toBe(false)
		fireEvent.click(screen.getAllByText("Open full message")[0])
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatMessageOpen",
			chatMessageOpen: { taskId: "task", instanceId: "instance", ts: 2 },
		})
		parse.mockRestore()
	})
	it("pages replace rows, preserve draft/images, and block historical sends and approvals", () => {
		const ref = React.createRef<ChatViewRef>()
		render(
			<ExtensionStateContextProvider>
				<ChatView ref={ref} isHidden={false} showAnnouncement={false} hideAnnouncement={() => {}} />
			</ExtensionStateContextProvider>,
		)
		push(page(1), [live])
		fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "keep draft" } })
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "selectedImages", images: ["data:image/png;base64,AA=="] },
				}),
			),
		)
		fireEvent.click(screen.getByText("Older"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatWindowRequest",
			chatWindowRequest: { taskId: "task", instanceId: "instance", revision: 8, before: 101 },
		})
		push({ ...page(2, false), reason: "staleRevision" }, [
			{ ts: 2, type: "ask", ask: "command", text: "old command" },
		])
		expect(screen.getByText(/History changed/)).toBeInTheDocument()
		expect(screen.getByText(/2-101 of 201 messages/)).toBeInTheDocument()
		fireEvent.click(screen.getByText("Newer"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatWindowRequest",
			chatWindowRequest: { taskId: "task", instanceId: "instance", revision: 8, after: 101 },
		})
		expect(screen.queryByTestId("legacy-row")).not.toBeInTheDocument()
		expect(screen.queryByTestId("monitor")).not.toBeInTheDocument()
		expect(screen.getByLabelText("Preserved draft (read-only history)")).toHaveValue("keep draft")
		expect(screen.getByText("1 draft image(s) preserved")).toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		act(() => {
			ref.current?.acceptInput()
			for (const invoke of ["sendMessage", "primaryButtonClick", "secondaryButtonClick"])
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "invoke", invoke, text: "do not send" } }),
				)
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("Return to latest"))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatWindowRequest",
			chatWindowRequest: { taskId: "task", instanceId: "instance", revision: 8, latest: true },
		})
		push(page(3), [live])
		expect(screen.queryByText("old command")).not.toBeInTheDocument()
		expect(screen.getByLabelText("Draft")).toHaveValue("keep draft")
		expect(screen.getByTestId("images")).toHaveTextContent("1")
	})
})
