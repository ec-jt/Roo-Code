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
	it("shows separate host and Mac SSH setup without changing settings", () => {
		const setCachedStateField = vi.fn()
		render(<BrowserSettings browserToolEnabled setCachedStateField={setCachedStateField} />)
		fireEvent.click(screen.getByText("Remote SSH: browser on the server or on your Mac"))
		expect(screen.getByText(/-R 127.0.0.1:9222:127.0.0.1:9222 USER@SERVER/)).toBeInTheDocument()
		expect(screen.getByText(/--user-data-dir=/)).toBeInTheDocument()
		expect(screen.getByText(/Other users on a shared server/)).toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
	it("defaults to managed Chromium and propagates a Chrome selection", () => {
		const setCachedStateField = vi.fn()
		render(<BrowserSettings browserToolEnabled setCachedStateField={setCachedStateField} />)
		const selector = screen.getByRole("combobox", { name: "settings:browser.localBrowser.label" })
		expect(selector).toHaveTextContent("settings:browser.localBrowser.chromium")
		fireEvent.keyDown(selector, { key: "ArrowDown" })
		fireEvent.click(screen.getByRole("option", { name: "Installed Google Chrome (Linux/macOS/Windows)" }))
		expect(setCachedStateField).toHaveBeenCalledWith("browserLocalBrowser", "chrome")
	})

	it("restores Chrome and preserves it while remote connections disable local selection", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<BrowserSettings
				browserToolEnabled
				browserLocalBrowser="chrome"
				setCachedStateField={setCachedStateField}
			/>,
		)
		const selector = screen.getByRole("combobox", { name: "settings:browser.localBrowser.label" })
		expect(selector).toHaveTextContent("Installed Google Chrome (Linux/macOS/Windows)")
		expect(selector).toBeEnabled()
		rerender(
			<BrowserSettings
				browserToolEnabled
				browserLocalBrowser="chrome"
				remoteBrowserEnabled
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(selector).toBeDisabled()
		expect(selector).toHaveTextContent("Installed Google Chrome (Linux/macOS/Windows)")
		rerender(
			<BrowserSettings
				browserToolEnabled
				browserLocalBrowser="chrome"
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(selector).toBeEnabled()
		expect(selector).toHaveTextContent("Installed Google Chrome (Linux/macOS/Windows)")
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("propagates switching back to managed Chromium", () => {
		const setCachedStateField = vi.fn()
		render(
			<BrowserSettings
				browserToolEnabled
				browserLocalBrowser="chrome"
				setCachedStateField={setCachedStateField}
			/>,
		)
		fireEvent.keyDown(screen.getByRole("combobox", { name: "settings:browser.localBrowser.label" }), {
			key: "ArrowDown",
		})
		fireEvent.click(screen.getByRole("option", { name: "settings:browser.localBrowser.chromium" }))
		expect(setCachedStateField).toHaveBeenCalledWith("browserLocalBrowser", "chromium")
	})

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
