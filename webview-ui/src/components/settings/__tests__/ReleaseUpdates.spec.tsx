import { act, fireEvent, render, screen } from "@testing-library/react"
import { ReleaseUpdates } from "../ReleaseUpdates"
import { vscode } from "@/utils/vscode"
import type { ReleaseUpdateState } from "@roo-code/types"
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: any) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))
const status = (overrides: Partial<ReleaseUpdateState> = {}) =>
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "releaseUpdateState",
					releaseUpdateState: {
						phase: "idle",
						currentVersion: "4.2.29",
						automatic: false,
						host: "Remote host",
						...overrides,
					},
				},
			}),
		),
	)
describe("GitHub release controls", () => {
	beforeEach(() => vi.clearAllMocks())
	it("requests status but does not check or install on mount", () => {
		render(<ReleaseUpdates />)
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "releaseUpdateAction", releaseUpdateAction: "status" })
		status()
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		fireEvent.click(screen.getByRole("button", { name: "Update / install latest" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "releaseUpdateAction",
			releaseUpdateAction: "install",
		})
	})
	it("requests opt-in without treating a click as confirmed", () => {
		render(<ReleaseUpdates />)
		status()
		fireEvent.click(screen.getByRole("checkbox"))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "releaseUpdateAction",
			releaseUpdateAction: "enableAutomatic",
		})
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		status({ automatic: true })
		expect(screen.getByRole("checkbox")).toBeChecked()
	})
	it("disables duplicate actions while busy and exposes reload only after installation", () => {
		render(<ReleaseUpdates />)
		status({ phase: "downloading" })
		expect(screen.getByRole("button", { name: "Update / install latest" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "Cancel update" })).toBeEnabled()
		status({ phase: "installed", installedVersion: "4.2.30" })
		fireEvent.click(screen.getByRole("button", { name: "Reload to activate" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "releaseUpdateAction",
			releaseUpdateAction: "reload",
		})
	})
})
