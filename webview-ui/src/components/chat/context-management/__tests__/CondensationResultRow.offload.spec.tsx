import { render, screen } from "@testing-library/react"

import { CondensationResultRow } from "../CondensationResultRow"
import { TruncationResultRow } from "../TruncationResultRow"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ chatWindow: { taskId: "t", instanceId: "i", following: false }, runningTask: {} }),
}))
vi.mock("react-i18next", async (original) => ({
	...(await original<typeof import("react-i18next")>()),
	useTranslation: () => ({
		t: (key: string, options?: { count?: number }) =>
			options?.count !== undefined ? `${key}:${options.count}` : key,
	}),
}))

// D3: offload ran but the summary or truncation still followed. The count must stay visible.
describe("context rows show prune/offload counts when condense or truncate follows", () => {
	it("shows the offload count on the condense row", () => {
		render(
			<CondensationResultRow
				data={{
					cost: 0.05,
					prevContextTokens: 90_000,
					newContextTokens: 20_000,
					summary: "summary",
					condenseId: "c1",
					offloadedCount: 3,
				}}
			/>,
		)
		expect(screen.getByText("chat:contextManagement.prune.offloaded:3")).toBeInTheDocument()
		expect(screen.queryByText(/prune\.description/)).toBeNull()
	})

	it("shows pruned and offloaded counts on the truncation row", () => {
		render(
			<TruncationResultRow
				data={{
					truncationId: "t1",
					messagesRemoved: 4,
					prevContextTokens: 90_000,
					newContextTokens: 40_000,
					prunedCount: 2,
					offloadedCount: 1,
				}}
			/>,
		)
		expect(screen.getByText("chat:contextManagement.prune.description:2")).toBeInTheDocument()
		expect(screen.getByText("chat:contextManagement.prune.offloaded:1")).toBeInTheDocument()
	})

	it("shows nothing extra without counts", () => {
		render(<CondensationResultRow data={{ cost: 0, prevContextTokens: 1, newContextTokens: 1, summary: "s" }} />)
		expect(screen.queryByText(/prune\./)).toBeNull()
	})
})
