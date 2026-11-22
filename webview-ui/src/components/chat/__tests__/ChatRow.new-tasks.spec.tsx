import React from "react"
import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChatRowContent } from "../ChatRow"
import type { ClineMessage } from "@roo-code/types"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
		i18n: { exists: () => true },
	}),
	Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
	initReactI18next: { type: "3rdParty", init: () => {} },
}))

let mockClineMessages: ClineMessage[] = []
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mcpServers: [],
		alwaysAllowMcp: false,
		currentCheckpoint: null,
		mode: "orchestrator",
		apiConfiguration: {},
		clineMessages: mockClineMessages,
	}),
}))
vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({ info: { supportsImages: true } }),
}))

const queryClient = new QueryClient()

function renderRow(message: ClineMessage) {
	mockClineMessages = [message]
	return render(
		<QueryClientProvider client={queryClient}>
			<ChatRowContent
				message={message}
				isExpanded={false}
				isLast={true}
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

describe("ChatRow - newTasks approval row", () => {
	it("lists each child's mode and first message line, plus the batch limits", () => {
		renderRow({
			ts: 1000,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({
				tool: "newTasks",
				tasks: [
					{ mode: "code", message: "\nImplement feature A\nmore detail" },
					{ mode: "debug", message: "Investigate test B" },
				],
				concurrency: 2,
				tokenBudget: 2_000_000,
			}),
		})
		expect(screen.getByText('chat:parallelSubtasks.wantsToStart {"count":2}')).toBeInTheDocument()
		const row = screen.getByTestId("new-tasks-row")
		const items = row.querySelectorAll("li")
		expect(items).toHaveLength(2)
		expect(items[0]).toHaveTextContent("code Implement feature A")
		expect(items[0]).not.toHaveTextContent("more detail")
		expect(items[1]).toHaveTextContent("debug Investigate test B")
		expect(row).toHaveTextContent('chat:parallelSubtasks.limits {"concurrency":2,"budget":"2,000,000"}')
	})

	it("renders a streaming (partial) payload without limits", () => {
		renderRow({
			ts: 1000,
			type: "ask",
			ask: "tool",
			partial: true,
			text: JSON.stringify({ tool: "newTasks", tasks: [{ mode: "code", message: "" }] }),
		})
		expect(screen.getByTestId("new-tasks-row").querySelectorAll("li")).toHaveLength(1)
		expect(screen.queryByText(/parallelSubtasks.limits/)).toBeNull()
	})
})
