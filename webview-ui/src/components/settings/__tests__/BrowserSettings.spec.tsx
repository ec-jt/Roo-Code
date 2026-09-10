import { render, screen, fireEvent } from "@testing-library/react"
import { BrowserSettings } from "../BrowserSettings"

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({ Trans: () => null }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeTextField: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
	VSCodeLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

describe("visible browser setting", () => {
	it("defaults to headless and propagates the headed selection", () => {
		const setCachedStateField = vi.fn()
		render(<BrowserSettings browserToolEnabled setCachedStateField={setCachedStateField} />)
		const checkbox = screen.getByLabelText("settings:browser.headed.label")
		expect(checkbox).not.toBeChecked()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledWith("browserHeaded", true)
	})

	it("restores the saved value and disables local visibility for remote connections", () => {
		render(<BrowserSettings browserToolEnabled browserHeaded remoteBrowserEnabled setCachedStateField={vi.fn()} />)
		const checkbox = screen.getByLabelText("settings:browser.headed.label")
		expect(checkbox).toBeChecked()
		expect(checkbox).toBeDisabled()
	})
})
