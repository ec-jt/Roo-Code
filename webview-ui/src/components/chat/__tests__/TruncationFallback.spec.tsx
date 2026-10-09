import { render, screen } from "@/utils/test-utils"
import { TruncationResultRow } from "../context-management/TruncationResultRow"

it("shows the overflow fallback reason without requiring expansion", () => {
	render(
		<TruncationResultRow
			data={{
				truncationId: "id",
				messagesRemoved: 12,
				prevContextTokens: 1000,
				newContextTokens: 500,
				fallbackReason: "context-limit",
			}}
		/>,
	)
	expect(screen.getByText(/excluded 12 older messages before the single retry/)).toBeInTheDocument()
	expect(screen.getByText(/Original history remains stored/)).toBeInTheDocument()
})
