import { render, screen, fireEvent } from "@testing-library/react"

import { NativeToolIntegrationsSettings } from "../NativeToolIntegrationsSettings"

describe("NativeToolIntegrationsSettings", () => {
	it("renders both API key inputs and propagates changes", () => {
		const setBraveApiKey = vi.fn()
		const setContext7ApiKey = vi.fn()

		render(
			<NativeToolIntegrationsSettings
				braveApiKey="brave-key"
				context7ApiKey="ctx7-key"
				setBraveApiKey={setBraveApiKey}
				setContext7ApiKey={setContext7ApiKey}
			/>,
		)

		expect(screen.getByText("Native Tool Integrations")).toBeInTheDocument()
		expect(screen.getByDisplayValue("brave-key")).toBeInTheDocument()
		expect(screen.getByDisplayValue("ctx7-key")).toBeInTheDocument()

		const braveInput = screen.getByPlaceholderText("Enter Brave Search API key...")
		const context7Input = screen.getByPlaceholderText("Enter Context7 API key...")
		fireEvent.input(braveInput, { target: { value: "new-brave-key" } })
		fireEvent.input(context7Input, { target: { value: "new-context7-key" } })

		expect(setBraveApiKey).toHaveBeenCalledWith("new-brave-key")
		expect(setContext7ApiKey).toHaveBeenCalledWith("new-context7-key")
	})
})
