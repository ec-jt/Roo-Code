import React from "react"

import { render, screen } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import enChat from "@src/i18n/locales/en/chat.json"
import { ChatRowContent } from "../ChatRow"

// Resolve "chat:" keys from the real English locale so the test checks the shipped text.
vi.mock("react-i18next", async () => {
	const chat = (await import("@src/i18n/locales/en/chat.json")).default as Record<string, any>
	const lookup = (key: string) =>
		key.startsWith("chat:")
			? (key
					.slice(5)
					.split(".")
					.reduce<any>((node, part) => node?.[part], chat) ?? key)
			: key
	return {
		useTranslation: () => ({ t: lookup, i18n: { exists: () => false } }),
		Trans: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
		initReactI18next: { type: "3rdParty", init: () => {} },
	}
})

const queryClient = new QueryClient()

describe("ChatRow - context_limit_rejected", () => {
	it("renders the translated provider rejection notice as a warning, not an error", () => {
		render(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<ChatRowContent
						message={{ type: "say", say: "context_limit_rejected", ts: Date.now() }}
						isExpanded={false}
						isLast={false}
						isStreaming={false}
						onToggleExpand={() => {}}
						onSuggestionClick={() => {}}
						onBatchFileResponse={() => {}}
						onFollowUpUnmount={() => {}}
						isFollowUpAnswered={false}
					/>
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
		const { title, description } = enChat.contextManagement.rejected
		expect(title).toBe("Context too large")
		expect(description).toBe(
			"The provider rejected the request because the context is too large. Recovering and retrying once.",
		)
		expect(screen.getByText(title)).toBeInTheDocument()
		expect(screen.getByText(description)).toBeInTheDocument()
		expect(screen.getByText(title).className).toContain("text-vscode-editorWarning-foreground")
		expect(screen.queryByText("API Request Failed")).toBeNull()
	})
})
