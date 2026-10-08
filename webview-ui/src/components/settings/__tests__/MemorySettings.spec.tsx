import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemorySettings } from "../MemorySettings"
import { vscode } from "@/utils/vscode"
vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const state = {
	projectKey: "project",
	projectLabel: "Test",
	rootPath: "/work",
	directory: "/storage",
	scope: "project",
	enabled: false,
	personalRecall: false,
	consentRevision: "disabled",
	listRevision: "list",
	records: [],
	errors: [],
	omitted: 0,
}
const receive = (value: object) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "memoryBrowser", memoryBrowser: value } }))
	})
beforeEach(() => vi.clearAllMocks())
it("loads disabled settings and sends project-correlated immediate consent", () => {
	render(<MemorySettings />)
	expect(vscode.postMessage).toHaveBeenCalledWith({
		type: "memoryBrowserRequest",
		memoryBrowserRequest: { action: "refresh", scope: "project" },
	})
	receive(state)
	expect(screen.getByLabelText("settings:memory.enabled")).not.toBeChecked()
	fireEvent.click(screen.getByLabelText("settings:memory.enabled"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "memoryBrowserRequest",
		memoryBrowserRequest: expect.objectContaining({
			action: "consent",
			projectKey: "project",
			consentRevision: "disabled",
			enabled: true,
		}),
	})
})
it("keeps an edited draft on a conflict and uses the record revision for save", () => {
	render(<MemorySettings />)
	const selected = {
		id: "record",
		name: "Preference",
		description: "Short",
		type: "feedback",
		body: "Original",
		revision: "old",
		modifiedAt: "today",
		createdAt: "today",
	}
	receive({ ...state, enabled: true, selected, records: [selected] })
	fireEvent.change(screen.getByLabelText("settings:memory.body"), { target: { value: "Updated" } })
	fireEvent.click(screen.getByText("settings:memory.save"))
	expect(vscode.postMessage).toHaveBeenLastCalledWith({
		type: "memoryBrowserRequest",
		memoryBrowserRequest: expect.objectContaining({
			expectedRevision: "old",
			input: expect.objectContaining({ body: "Updated" }),
		}),
	})
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "memoryBrowser", memoryError: "Conflict" } }))
	})
	expect(screen.getByLabelText("settings:memory.body")).toHaveValue("Updated")
	expect(screen.getByRole("alert")).toHaveTextContent("Conflict")
})
