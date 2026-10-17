import React from "react"
import { render, screen, act, fireEvent } from "@/utils/test-utils"
import { LMStudio } from "../LMStudio"
const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("@src/components/ui/hooks/useRouterModels", () => ({ useRouterModels: () => ({ data: {} }) }))
vi.mock("../../ModelPicker", () => ({ ModelPicker: ({ models }: any) => <div>{Object.keys(models).join(",")}</div> }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, type, onInput }: any) => (
		<label>
			{children}
			<input value={value} type={type} onChange={onInput} />
		</label>
	),
	VSCodeLink: ({ children }: any) => <span>{children}</span>,
}))
const reply = (requestId: string, models: object, error?: string) =>
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "lmStudioModels",
					lmStudioModelsRequestId: requestId,
					lmStudioModels: models,
					lmStudioModelsError: error,
				},
			}),
		)
	})
describe("LM Studio discovery settings", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})
	afterEach(() => vi.useRealTimers())
	it("uses draft URL/token and ignores stale replies after either changes", () => {
		const setField = vi.fn()
		const { rerender } = render(
			<LMStudio
				apiConfiguration={{ lmStudioBaseUrl: "http://first", lmStudioApiKey: "first-token" }}
				setApiConfigurationField={setField}
			/>,
		)
		act(() => vi.advanceTimersByTime(300))
		const first = postMessage.mock.calls.at(-1)![0]
		expect(first.values).toMatchObject({ baseUrl: "http://first", apiKey: "first-token" })
		rerender(
			<LMStudio
				apiConfiguration={{ lmStudioBaseUrl: "http://second", lmStudioApiKey: "" }}
				setApiConfigurationField={setField}
			/>,
		)
		act(() => vi.advanceTimersByTime(300))
		const second = postMessage.mock.calls.at(-1)![0]
		expect(second.values).toMatchObject({ baseUrl: "http://second", apiKey: "" })
		reply(first.values.requestId, { staleModel: {} })
		expect(screen.queryByText("staleModel")).not.toBeInTheDocument()
		reply(second.values.requestId, { currentModel: {} })
		expect(screen.getByText("currentModel")).toBeInTheDocument()
		expect(screen.queryByText("Loading LM Studio models...")).not.toBeInTheDocument()
	})
	it("shows empty and authentication results and offers refresh", () => {
		render(<LMStudio apiConfiguration={{}} setApiConfigurationField={vi.fn()} />)
		act(() => vi.advanceTimersByTime(300))
		reply(postMessage.mock.calls.at(-1)![0].values.requestId, {})
		expect(screen.getByText("No chat models were returned by this server.")).toBeInTheDocument()
		fireEvent.click(screen.getByText("Refresh models"))
		act(() => vi.advanceTimersByTime(300))
		reply(postMessage.mock.calls.at(-1)![0].values.requestId, {}, "LM Studio authentication failed (HTTP 401).")
		expect(screen.getByRole("alert")).toHaveTextContent("HTTP 401")
	})
})
