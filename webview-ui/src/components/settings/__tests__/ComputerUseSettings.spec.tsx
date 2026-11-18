import { render, screen, fireEvent, act } from "@testing-library/react"

import { vscode } from "@/utils/vscode"

import { ComputerUseSettings, parseAllowedApps } from "../ComputerUseSettings"

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
}))

describe("ComputerUseSettings", () => {
	beforeEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("propagates the enable toggle and hides details while disabled", () => {
		const setCachedStateField = vi.fn()
		render(<ComputerUseSettings computerUseEnabled={false} setCachedStateField={setCachedStateField} />)

		expect(screen.queryByTestId("computer-use-allowed-apps")).not.toBeInTheDocument()
		expect(screen.getByText("settings:computerUse.enable.warning")).toBeInTheDocument()

		const checkbox = screen.getByLabelText("settings:computerUse.enable.label")
		expect(checkbox).not.toBeChecked()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledWith("computerUseEnabled", true)
	})

	it("shows the background mode toggle when enabled and propagates changes", () => {
		const setCachedStateField = vi.fn()
		render(
			<ComputerUseSettings
				computerUseEnabled
				computerUseBackgroundMode={false}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const checkbox = screen.getByTestId("computer-use-background-mode-checkbox")
		expect(checkbox).not.toBeChecked()
		expect(screen.getByText("settings:computerUse.backgroundMode.description")).toBeInTheDocument()
		fireEvent.click(checkbox)
		expect(setCachedStateField).toHaveBeenCalledWith("computerUseBackgroundMode", true)
	})

	it("hides the background mode toggle while desktop control is off", () => {
		render(<ComputerUseSettings computerUseEnabled={false} setCachedStateField={vi.fn()} />)
		expect(screen.queryByTestId("computer-use-background-mode-checkbox")).not.toBeInTheDocument()
	})

	it("parses the allowlist as one trimmed entry per line", () => {
		const setCachedStateField = vi.fn()
		render(
			<ComputerUseSettings
				computerUseEnabled
				computerUseAllowedApps={["Safari"]}
				setCachedStateField={setCachedStateField}
			/>,
		)

		const textarea = screen.getByTestId("computer-use-allowed-apps") as HTMLTextAreaElement
		expect(textarea.value).toBe("Safari")

		fireEvent.change(textarea, { target: { value: "Safari\n  Notes  \n\n\r\nTerminal\n" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("computerUseAllowedApps", ["Safari", "Notes", "Terminal"])

		fireEvent.change(textarea, { target: { value: "" } })
		expect(setCachedStateField).toHaveBeenLastCalledWith("computerUseAllowedApps", [])
	})

	it("parseAllowedApps handles CRLF and blank lines", () => {
		expect(parseAllowedApps("a\r\n\r\n b \n")).toEqual(["a", "b"])
		expect(parseAllowedApps("   ")).toEqual([])
	})

	it("posts the permissions check message and shows the result", () => {
		render(<ComputerUseSettings computerUseEnabled setCachedStateField={vi.fn()} />)

		fireEvent.click(screen.getByTestId("computer-use-check-permissions"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "checkComputerUsePermissions" })
		expect(screen.getByText("settings:computerUse.permissions.checkingButton")).toBeInTheDocument()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "computerUsePermissionsResult",
						success: false,
						text: "Missing Accessibility",
						values: { remedy: ["Open System Settings"], warnings: [] },
					},
				}),
			)
		})

		const result = screen.getByTestId("computer-use-permissions-result")
		expect(result).toHaveTextContent("Missing Accessibility")
		expect(result).toHaveTextContent("Open System Settings")
		expect(screen.getByText("settings:computerUse.permissions.checkButton")).toBeInTheDocument()
	})

	it("shows the vision and stop-shortcut notes when enabled", () => {
		render(<ComputerUseSettings computerUseEnabled setCachedStateField={vi.fn()} />)
		expect(screen.getByText("settings:computerUse.visionRequired")).toBeInTheDocument()
		expect(screen.getByText("settings:computerUse.stopShortcut")).toBeInTheDocument()
	})
})
