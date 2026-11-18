import { render, screen } from "@testing-library/react"

import type { ClineMessage } from "@roo-code/types"

import { ComputerActionRow, ComputerActionResultRow, COMPUTER_ACTION_TEXT_PREVIEW_LENGTH } from "../ComputerActionRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
	}),
}))
vi.mock("../../common/ImageViewer", () => ({
	ImageViewer: ({ imageUri }: { imageUri: string }) => <img data-testid="image-viewer" src={imageUri} />,
}))

const msg = (type: "ask" | "say", kind: string, payload: unknown): ClineMessage =>
	({
		ts: 1,
		type,
		...(type === "ask" ? { ask: kind } : { say: kind }),
		text: JSON.stringify(payload),
	}) as ClineMessage

describe("ComputerActionRow", () => {
	it("renders a click with coordinate and executed coordinate", () => {
		render(
			<ComputerActionRow
				message={msg("say", "computer_action", {
					action: "click",
					coordinate: "10,20",
					executedCoordinate: "20,40",
				})}
			/>,
		)
		expect(screen.getByTestId("computer-action-name")).toHaveTextContent("chat:computerAction.actions.click")
		expect(screen.getByTestId("computer-action-coordinate")).toHaveTextContent("10,20")
		expect(screen.getByTestId("computer-action-executed-coordinate")).toHaveTextContent("20,40")
	})

	it("truncates typed text in the say row but shows it in full in the approval ask", () => {
		const longText = "x".repeat(COMPUTER_ACTION_TEXT_PREVIEW_LENGTH + 50)
		const { unmount } = render(
			<ComputerActionRow message={msg("say", "computer_action", { action: "type", text: longText })} />,
		)
		expect(screen.getByTestId("computer-action-text").textContent).toBe(
			`${"x".repeat(COMPUTER_ACTION_TEXT_PREVIEW_LENGTH)}…`,
		)
		unmount()

		render(<ComputerActionRow message={msg("ask", "computer_action", { action: "type", text: longText })} />)
		expect(screen.getByTestId("computer-action-text").textContent).toBe(longText)
	})

	it("shows key combo and scroll parameters", () => {
		render(
			<ComputerActionRow
				message={msg("say", "computer_action", {
					action: "scroll",
					direction: "down",
					amount: 3,
					key: "cmd+c",
				})}
			/>,
		)
		expect(screen.getByTestId("computer-action-key")).toHaveTextContent("cmd+c")
		expect(screen.getByTestId("computer-action-scroll")).toHaveTextContent("down × 3")
	})

	it("lists every step of a batch with full text in the approval", () => {
		const longText = "y".repeat(COMPUTER_ACTION_TEXT_PREVIEW_LENGTH + 10)
		render(
			<ComputerActionRow
				message={msg("ask", "computer_action", {
					steps: [
						{ action: "click", coordinate: "10,20" },
						{ action: "type", text: longText, submit: true },
						{ action: "key", key: "enter" },
					],
				})}
			/>,
		)
		expect(screen.getByTestId("computer-action-steps")).toHaveTextContent(
			'chat:computerAction.batchSteps {"count":3}',
		)
		expect(screen.getByTestId("computer-action-step-0")).toHaveTextContent("chat:computerAction.actions.click")
		expect(screen.getByTestId("computer-action-step-0")).toHaveTextContent("10,20")
		expect(screen.getByTestId("computer-action-step-1")).toHaveTextContent("chat:computerAction.submit")
		expect(screen.getByTestId("computer-action-step-1").querySelector("pre")?.textContent).toBe(longText)
		expect(screen.getByTestId("computer-action-step-2")).toHaveTextContent("enter")
	})

	it("shows executed coordinates for batch steps and the no-screenshot note", () => {
		render(
			<ComputerActionRow
				message={msg("say", "computer_action", {
					steps: [{ action: "click", coordinate: "10,20", executedCoordinate: "20,40" }],
					screenshot: false,
				})}
			/>,
		)
		expect(screen.getByTestId("computer-action-step-0")).toHaveTextContent("20,40")
		expect(screen.getByTestId("computer-action-no-screenshot")).toBeInTheDocument()
	})

	it("renders nothing for invalid JSON", () => {
		const { container } = render(
			<ComputerActionRow
				message={{ ts: 1, type: "say", say: "computer_action", text: "not json" } as ClineMessage}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})
})

describe("ComputerActionResultRow", () => {
	it("renders the screenshot, active window, and cursor", () => {
		render(
			<ComputerActionResultRow
				message={msg("say", "computer_action_result", {
					screenshot: "data:image/png;base64,AAAA",
					activeWindowTitle: "Notes",
					cursorPosition: "5,6",
				})}
			/>,
		)
		expect(screen.getByTestId("image-viewer")).toHaveAttribute("src", "data:image/png;base64,AAAA")
		expect(screen.getByTestId("computer-action-active-window")).toHaveTextContent("Notes")
		expect(screen.getByTestId("computer-action-cursor")).toHaveTextContent("5,6")
	})

	it("renders a window list without a screenshot", () => {
		render(
			<ComputerActionResultRow
				message={msg("say", "computer_action_result", {
					windows: [
						{ id: 1, title: "Safari", x: 0, y: 0, width: 1, height: 1, active: true },
						{ id: 2, title: "Notes", x: 0, y: 0, width: 1, height: 1, active: false },
					],
				})}
			/>,
		)
		expect(screen.queryByTestId("image-viewer")).not.toBeInTheDocument()
		const list = screen.getByTestId("computer-action-windows")
		expect(list).toHaveTextContent("Safari")
		expect(list).toHaveTextContent("Notes")
	})
})
