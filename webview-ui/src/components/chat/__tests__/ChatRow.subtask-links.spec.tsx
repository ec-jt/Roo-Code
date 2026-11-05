import React from "react"
import { render, screen, fireEvent } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatRowContent } from "../ChatRow"
import type { HistoryItem, ClineMessage } from "@roo-code/types"

// Mock vscode API
const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (msg: unknown) => mockPostMessage(msg),
	},
}))

// Mock i18n
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => {
			const map: Record<string, string> = {
				"chat:subtasks.wantsToCreate": "Roo wants to create a new subtask",
				"chat:subtasks.resultContent": "Task result",
				"chat:subtasks.goToSubtask": "Go to subtask",
			}
			return map[key] ?? key
		},
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

// Mock extension state context
let mockCurrentTaskItem: Partial<HistoryItem> | undefined = undefined
let mockClineMessages: ClineMessage[] = []

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "code",
		apiConfiguration: {},
		clineMessages: mockClineMessages,
		currentTaskItem: mockCurrentTaskItem,
	}),
}))

// Mock useSelectedModel hook
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const queryClient = new QueryClient()

function renderChatRow(message: any, currentTaskItem?: Partial<HistoryItem>, clineMessages?: ClineMessage[]) {
	mockCurrentTaskItem = currentTaskItem
	mockClineMessages = clineMessages || [message]

	return render(
		<QueryClientProvider client={queryClient}>
			<ChatRowContent
				message={message}
				isExpanded={false}
				isLast={false}
				isStreaming={false}
				onToggleExpand={() => {}}
				onSuggestionClick={() => {}}
				onBatchFileResponse={() => {}}
				onFollowUpUnmount={() => {}}
				isFollowUpAnswered={false}
			/>
		</QueryClientProvider>,
	)
}

describe("ChatRow - subtask links", () => {
	beforeEach(() => mockPostMessage.mockClear())
	const creation = (subtaskId?: string): ClineMessage => ({
		ts: 1000,
		type: "ask",
		ask: "tool",
		subtaskId,
		text: JSON.stringify({ tool: "newTask", mode: "code", content: "Latest task" }),
	})
	it("opens the card's durable ID when earlier creations are outside the visible page", () => {
		const message = creation("latest-child")
		renderChatRow(message, { childIds: ["old-child", "latest-child"] }, [message])
		fireEvent.click(screen.getByText("Go to subtask"))
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "latest-child" })
	})
	it("does not guess from array offsets or stale delegation metadata", () => {
		renderChatRow(creation(), { childIds: ["old-child"], delegatedToId: "old-child" })
		expect(screen.queryByText("Go to subtask")).toBeNull()
	})
	it("hides the creation link when its result follows immediately", () => {
		const message = creation("child")
		renderChatRow(message, undefined, [
			message,
			{ ts: 1001, type: "say", say: "subtask_result", subtaskId: "child" },
		])
		expect(screen.queryByText("Go to subtask")).toBeNull()
	})
	it("opens an older result's own child, not the latest completed child", () => {
		renderChatRow(
			{ ts: 1000, type: "say", say: "subtask_result", text: "Done", subtaskId: "older-child" },
			{ completedByChildId: "latest-child" },
		)
		fireEvent.click(screen.getByText("Go to subtask"))
		expect(mockPostMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "older-child" })
	})
	it("does not link an unresolved result to unrelated completion metadata", () => {
		renderChatRow(
			{ ts: 1000, type: "say", say: "subtask_result", text: "Done" },
			{ completedByChildId: "latest-child" },
		)
		expect(screen.queryByText("Go to subtask")).toBeNull()
	})
})
