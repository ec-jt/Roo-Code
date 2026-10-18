import { fireEvent, render, screen } from "@testing-library/react"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import McpEnabledToggle from "../McpEnabledToggle"

vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: vi.fn() }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))

describe("McpEnabledToggle", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each([true, false])("immediately persists the toggle from %s without changing tool approval", (mcpEnabled) => {
		const setMcpEnabled = vi.fn()
		vi.mocked(useExtensionState).mockReturnValue({ mcpEnabled, setMcpEnabled } as unknown as ReturnType<
			typeof useExtensionState
		>)
		render(<McpEnabledToggle />)

		fireEvent.click(screen.getByRole("checkbox"))

		expect(setMcpEnabled).toHaveBeenCalledWith(!mcpEnabled)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "updateSettings",
			updatedSettings: { mcpEnabled: !mcpEnabled },
		})
	})
})
