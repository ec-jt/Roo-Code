import { fireEvent, render, screen } from "@testing-library/react"
import { ReasoningBlock } from "../ReasoningBlock"

const state = vi.hoisted(() => ({ reasoningBlockCollapsed: undefined as boolean | undefined }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (_key: string, options: { count: number }) => `${options.count}s` }),
}))

describe("compact live reasoning", () => {
	beforeEach(() => {
		state.reasoningBlockCollapsed = undefined
	})
	it("starts collapsed with an active indicator even without text", () => {
		render(<ReasoningBlock content="" ts={Date.now()} isStreaming isLast />)
		expect(screen.getByRole("status")).toHaveTextContent("Reasoning…")
		expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByTestId("reasoning-tail")).toBeNull()
	})
	it("follows a short tail without expanding the block as new content arrives", () => {
		const ts = Date.now()
		const open = vi.fn()
		const { rerender } = render(
			<ReasoningBlock
				content={"old prefix" + "x".repeat(5000) + " latest"}
				ts={ts}
				isStreaming
				isLast
				truncated
				onOpenFull={open}
			/>,
		)
		fireEvent.click(screen.getByRole("button"))
		const tail = screen.getByTestId("reasoning-tail")
		expect(tail).toHaveClass("max-h-24")
		expect(tail.textContent).not.toContain("old prefix")
		Object.defineProperties(tail, {
			scrollHeight: { configurable: true, value: 500 },
			clientHeight: { configurable: true, value: 96 },
		})
		rerender(
			<ReasoningBlock
				content={"x".repeat(5000) + " newest"}
				ts={ts}
				isStreaming
				isLast
				truncated
				onOpenFull={open}
			/>,
		)
		expect(tail.scrollTop).toBe(500)
		expect(tail.textContent).toContain("newest")
		fireEvent.click(screen.getByRole("button", { name: "Open full reasoning" }))
		expect(open).toHaveBeenCalledTimes(1)
		rerender(<ReasoningBlock content="done" ts={ts} isStreaming={false} isLast />)
		expect(screen.queryByRole("status")).toBeNull()
	})
	it("pauses following when scrolled up and lets the user return to latest", () => {
		state.reasoningBlockCollapsed = false
		const ts = Date.now()
		const { rerender } = render(<ReasoningBlock content="one" ts={ts} isStreaming isLast />)
		const tail = screen.getByTestId("reasoning-tail")
		Object.defineProperties(tail, {
			scrollHeight: { configurable: true, value: 500 },
			clientHeight: { configurable: true, value: 96 },
		})
		tail.scrollTop = 0
		fireEvent.scroll(tail)
		rerender(<ReasoningBlock content="two" ts={ts} isStreaming isLast />)
		expect(tail.scrollTop).toBe(0)
		fireEvent.click(screen.getByRole("button", { name: "Follow latest" }))
		expect(tail.scrollTop).toBe(500)
	})
	it("does not mark old reasoning active and hides completed empty blocks", () => {
		const { rerender, container } = render(
			<ReasoningBlock content="prior" ts={Date.now()} isStreaming isLast={false} />,
		)
		expect(screen.queryByRole("status")).toBeNull()
		rerender(<ReasoningBlock content="" ts={Date.now()} isStreaming={false} isLast />)
		expect(container).toBeEmptyDOMElement()
	})
})
