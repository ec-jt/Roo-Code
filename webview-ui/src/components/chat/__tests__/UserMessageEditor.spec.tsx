import React from "react"
import { act, fireEvent, render, screen } from "@/utils/test-utils"
import type { ChatWindowState, ClineMessage } from "@roo-code/types"
import { UserMessageEditor } from "../UserMessageEditor"
import { PlainHistoryMessage } from "../ChatWindowControls"
import { vscode } from "@/utils/vscode"

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))

const page = (following = true): ChatWindowState => ({
	taskId: "task",
	instanceId: "instance",
	revision: 8,
	sequence: 1,
	startIndex: following ? 101 : 1,
	endIndex: following ? 201 : 101,
	totalMessages: 201,
	hasOlder: following,
	hasNewer: !following,
	following,
	truncatedTs: [],
	byteLength: 100,
	summary: {
		tokenUsage: { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0, contextTokens: 0 },
		files: [],
		filesOmitted: 0,
	},
})

const truncatedUserMessage: ClineMessage = {
	ts: 150,
	type: "say",
	say: "user_feedback",
	text: "truncated prefix",
	chatPreview: { index: 149, truncated: true, label: "user feedback", hasContent: true },
}

const reply = (data: Partial<{ text: string; images: string[]; tooLarge: boolean; error: string }>) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "chatMessageEditData",
					chatMessageEditData: {
						taskId: "task",
						instanceId: "instance",
						ts: 150,
						index: 149,
						revision: 8,
						...data,
					},
				},
			}),
		)
	})

const submitted = () => postMessage.mock.calls.filter(([m]) => (m as { type: string }).type === "submitEditedMessage")

describe("user message editor", () => {
	beforeEach(() => vi.clearAllMocks())

	it("retrieves the authoritative message before editing and never submits the truncated prefix", () => {
		render(<UserMessageEditor message={truncatedUserMessage} window={page()} onClose={() => {}} />)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 150, index: 149, revision: 8 },
		})
		expect(screen.getByText("Loading the full message...")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Save and confirm" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))
		expect(submitted()).toHaveLength(0)

		reply({ text: "full message tail", images: ["data:image/png;base64,AAAA"] })
		const box = screen.getByRole("textbox", { name: "Your message text" })
		expect(box).toHaveValue("full message tail")
		expect(screen.getByText("Existing attachments are kept when you save.")).toBeInTheDocument()
		fireEvent.change(box, { target: { value: "edited full message" } })
		fireEvent.click(screen.getByRole("button", { name: "Save and confirm" }))
		expect(submitted()).toHaveLength(1)
		expect(submitted()[0][0]).toEqual({
			type: "submitEditedMessage",
			value: 150,
			editedMessageContent: "edited full message",
			images: ["data:image/png;base64,AAAA"],
			taskId: "task",
			instanceId: "instance",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 150, index: 149, revision: 8 },
		})
	})
	it("preserves a draft and disables Save when the loaded history revision changes", () => {
		const view = render(<UserMessageEditor message={truncatedUserMessage} window={page()} onClose={() => {}} />)
		reply({ text: "full message" })
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "keep draft" } })
		view.rerender(
			<UserMessageEditor message={truncatedUserMessage} window={{ ...page(), revision: 9 }} onClose={() => {}} />,
		)
		expect(screen.getByRole("textbox")).toHaveValue("keep draft")
		expect(screen.getByRole("button", { name: "Save and confirm" })).toBeDisabled()
		expect(submitted()).toHaveLength(0)
	})

	it("ignores a reply for another task and surfaces the backend limitation", () => {
		render(<UserMessageEditor message={truncatedUserMessage} window={page()} onClose={() => {}} />)
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "chatMessageEditData",
						chatMessageEditData: { taskId: "other", instanceId: "instance", ts: 150, text: "leak" },
					},
				}),
			)
		})
		expect(screen.queryByRole("textbox", { name: "Your message text" })).not.toBeInTheDocument()
		reply({ error: "Return to the latest page to edit your message." })
		expect(screen.getByRole("alert")).toHaveTextContent("Return to the latest page")
		expect(screen.getByRole("button", { name: "Save and confirm" })).toBeDisabled()
		expect(submitted()).toHaveLength(0)
	})

	it("reports an oversized message instead of editing a partial value", () => {
		render(<UserMessageEditor message={truncatedUserMessage} window={page()} onClose={() => {}} />)
		reply({ tooLarge: true })
		expect(screen.getByRole("alert")).toHaveTextContent(/too large to edit inline/)
		expect(screen.getByRole("button", { name: "Save and confirm" })).toBeDisabled()
	})
})

describe("plain history user message edit affordance", () => {
	beforeEach(() => vi.clearAllMocks())

	it("offers edit for the user's own message on the latest page and opens the editor", () => {
		render(<PlainHistoryMessage message={truncatedUserMessage} window={page()} />)
		fireEvent.click(screen.getByRole("button", { name: "Edit" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "chatMessageEdit",
			chatMessageEdit: { taskId: "task", instanceId: "instance", ts: 150, index: 149, revision: 8 },
		})
	})

	it.each([
		["history", page(false)],
		["root", page()],
	])("hides edit on %s rows", (label, state) => {
		const message: ClineMessage =
			label === "root"
				? {
						...truncatedUserMessage,
						chatPreview: { index: 0, truncated: true, label: "task", hasContent: true },
					}
				: truncatedUserMessage
		render(<PlainHistoryMessage message={message} window={state} />)
		expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
	})

	it("hides edit for non-user rows", () => {
		render(
			<PlainHistoryMessage
				message={{
					ts: 3,
					type: "say",
					say: "command_output",
					text: "out",
					chatPreview: { index: 2, truncated: false, label: "command output", hasContent: true },
				}}
				window={page()}
			/>,
		)
		expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
	})
})
