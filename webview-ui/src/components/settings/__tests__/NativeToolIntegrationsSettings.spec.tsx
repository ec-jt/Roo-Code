import { render, screen, fireEvent } from "@testing-library/react"

import { NativeToolIntegrationsSettings } from "../NativeToolIntegrationsSettings"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeTextField: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

describe("NativeToolIntegrationsSettings", () => {
	it.each([undefined, "", " \t "])("keeps Context7 toggles available with key %j", (context7ApiKey) => {
		const setNativeToolEnabled = vi.fn()
		render(
			<NativeToolIntegrationsSettings
				context7ApiKey={context7ApiKey}
				setBraveApiKey={vi.fn()}
				setContext7ApiKey={vi.fn()}
				setNativeToolEnabled={setNativeToolEnabled}
			/>,
		)
		expect(screen.getByText("Context7 API Key (optional)")).toBeInTheDocument()
		expect(screen.getByText(/anonymous access with lower rate limits/)).toBeInTheDocument()
		expect(screen.queryByText(/missing context7 credential/)).not.toBeInTheDocument()
		for (const name of ["context7_resolve_library_id", "context7_query_docs"]) {
			const checkbox = screen.getByRole("checkbox", { name: new RegExp(name) })
			expect(checkbox).not.toBeDisabled()
			expect(checkbox).toBeChecked()
			fireEvent.click(checkbox)
			expect(setNativeToolEnabled).toHaveBeenCalledWith({ [name]: false })
		}
		expect(screen.getByRole("checkbox", { name: /brave_web_search/ })).toBeDisabled()
		expect(screen.getByRole("checkbox", { name: /git_tools/ })).toBeDisabled()
	})

	it("allows re-enabling explicitly disabled Context7 tools without a key", () => {
		const setNativeToolEnabled = vi.fn()
		render(
			<NativeToolIntegrationsSettings
				setBraveApiKey={vi.fn()}
				setContext7ApiKey={vi.fn()}
				setNativeToolEnabled={setNativeToolEnabled}
				nativeToolEnabled={{ context7_query_docs: false, brave_web_search: false }}
			/>,
		)
		const checkbox = screen.getByRole("checkbox", { name: /context7_query_docs/ })
		expect(checkbox).not.toBeDisabled()
		expect(checkbox).not.toBeChecked()
		fireEvent.click(checkbox)
		expect(setNativeToolEnabled).toHaveBeenCalledWith({ brave_web_search: false })
	})

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
