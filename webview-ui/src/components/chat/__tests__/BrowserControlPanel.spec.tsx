import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { BrowserControlPanel } from "../BrowserControlPanel"
import { vscode } from "@/utils/vscode"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const state = {
	sessionId: "session",
	connected: true,
	tabId: "tab",
	generation: 0,
	transport: "cdp",
	ownership: "attached",
	certificatePolicy: "verify",
	extensionHost: { hostname: "extension-host", platform: "linux", remoteName: "ssh-remote" },
	capabilities: { status: true, evaluate: false },
}
const reply = (data: Record<string, unknown>) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: "browserControlResponse", browserControlResponse: data } }),
		)
	})
const lastRequest = () => vi.mocked(vscode.postMessage).mock.calls.at(-1)![0].browserControlRequest!
function open() {
	fireEvent.click(screen.getByRole("button", { name: "Browser controls" }))
	fireEvent.click(screen.getByRole("button", { name: "Refresh status" }))
}
describe("browser control panel", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal("acquireVsCodeApi", vi.fn())
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})
	it("accepts only correlated status and displays the actual extension host", () => {
		render(<BrowserControlPanel taskId="task" />)
		open()
		const request = lastRequest()
		reply({ requestId: "wrong", taskId: "task", state })
		expect(screen.queryByText(/Extension host:/)).not.toBeInTheDocument()
		reply({ ...request, instanceId: "instance", state })
		expect(screen.getByText(/Extension host: extension-host, linux, ssh-remote/)).toBeInTheDocument()
		expect(screen.getByText(/Unavailable: evaluate/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "List tabs" }))
		expect(lastRequest()).toMatchObject({
			action: "tabs",
			taskId: "task",
			instanceId: "instance",
			sessionId: "session",
		})
	})
	it("rejects wrong-session replies and keeps selected tab requests narrow", () => {
		render(<BrowserControlPanel taskId="task" />)
		open()
		reply({ ...lastRequest(), instanceId: "instance", state })
		fireEvent.click(screen.getByRole("button", { name: "List tabs" }))
		const request = lastRequest()
		const tabs = [{ id: "tab2", url: "https://example.test/path", selected: false, owned: false }]
		reply({ ...request, requestedSessionId: "other", state, tabs })
		expect(screen.queryByText("https://example.test/path")).not.toBeInTheDocument()
		reply({ ...request, requestedSessionId: "session", state, tabs })
		fireEvent.click(screen.getByRole("button", { name: "Select tab" }))
		expect(lastRequest()).toMatchObject({ action: "select", tabId: "tab2", sessionId: "session" })
		expect(lastRequest()).not.toHaveProperty("command")
	})
	it("discards outstanding replies when the task changes", () => {
		const { rerender } = render(<BrowserControlPanel taskId="task" />)
		open()
		const request = lastRequest()
		rerender(<BrowserControlPanel taskId="other" />)
		fireEvent.click(screen.getByRole("button", { name: "Browser controls" }))
		reply({ ...request, instanceId: "instance", state })
		expect(screen.queryByText(/Extension host:/)).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled()
	})
	it("requires refresh after a timeout and ignores late replies", () => {
		vi.useFakeTimers()
		render(<BrowserControlPanel taskId="task" />)
		open()
		const request = lastRequest()
		act(() => vi.advanceTimersByTime(120_001))
		reply({ ...request, instanceId: "instance", state })
		expect(screen.getByRole("alert")).toHaveTextContent("Request timed out")
		expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled()
	})
	it("does not send browser requests through the development fallback", () => {
		vi.stubGlobal("acquireVsCodeApi", undefined)
		render(<BrowserControlPanel taskId="task" />)
		open()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByRole("alert")).toHaveTextContent("native VS Code extension host")
	})
	it("offers certificate review only while disconnected and shows its broad session warning", () => {
		render(<BrowserControlPanel taskId="task" />)
		open()
		reply({ ...lastRequest(), instanceId: "instance", state })
		expect(screen.getByRole("button", { name: "Review isolated certificate exception" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "Refresh status" }))
		reply({ ...lastRequest(), instanceId: "instance", state: { ...state, connected: false, ownership: "none" } })
		fireEvent.click(screen.getByRole("button", { name: "Review isolated certificate exception" }))
		const request = lastRequest()
		expect(request).toMatchObject({ action: "start_certificate_session", sessionId: "session" })
		expect(request).not.toHaveProperty("approved")
		reply({
			...request,
			requestedSessionId: "session",
			state: { ...state, certificatePolicy: "isolated-session-exception" },
		})
		expect(screen.getByText(/all invalid certificates are accepted/)).toBeInTheDocument()
	})
	it("starts and stops a bridge with metadata-only correlated requests", () => {
		render(<BrowserControlPanel taskId="task" />)
		open()
		reply({ ...lastRequest(), instanceId: "instance", state: { ...state, connected: false } })
		fireEvent.click(screen.getByRole("button", { name: "Start Chrome bridge" }))
		const request = lastRequest()
		expect(request).toEqual(
			expect.objectContaining({ action: "start_bridge", sessionId: "session", instanceId: "instance" }),
		)
		expect(Object.keys(request).sort()).toEqual(["action", "instanceId", "requestId", "sessionId", "taskId"])
		reply({
			...request,
			requestedSessionId: "session",
			state: { ...state, connected: false, transport: "chrome-extension", sessionId: "bridge" },
		})
		expect(screen.getByRole("button", { name: "Start Chrome bridge" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "Stop Chrome bridge" }))
		expect(lastRequest()).toMatchObject({ action: "stop_bridge", sessionId: "bridge" })
	})
})
