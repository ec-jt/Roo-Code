import { act, renderHook, cleanup } from "@testing-library/react"
import type { ExtensionMessage } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { useLiteLLMModels } from "../useLiteLLMModels"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const models = { "proxy-alias": { contextWindow: 262144, maxTokens: 32768, supportsPromptCache: false } }
const lastRequest = () => vi.mocked(vscode.postMessage).mock.calls.at(-1)![0]
const reply = (message: ExtensionMessage) =>
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))

describe("form-local LiteLLM discovery", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})
	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("sends draft credentials once when manually refreshed before debounce", () => {
		const { result } = renderHook(() => useLiteLLMModels(true, "https://draft.test/v1", "draft-key"))
		act(() => result.current.refresh())
		act(() => vi.advanceTimersByTime(300))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(lastRequest()).toEqual({
			type: "requestLiteLLMModels",
			requestId: expect.any(String),
			values: { baseUrl: "https://draft.test/v1", apiKey: "draft-key" },
		})
	})

	it("ignores aggregate, wrong-ID and stale replies, including errors", () => {
		const { result } = renderHook(() => useLiteLLMModels(true, "https://draft.test", "key"))
		act(() => result.current.refresh())
		const oldId = lastRequest().requestId
		act(() => result.current.refresh())
		const requestId = lastRequest().requestId
		expect(requestId).not.toBe(oldId)
		reply({ type: "routerModels" })
		reply({ type: "liteLLMModels", requestId: oldId, liteLLMModels: models })
		reply({ type: "liteLLMModels", requestId: oldId, error: "stale error" })
		expect(result.current.status).toBe("loading")
		reply({ type: "liteLLMModels", requestId, liteLLMModels: models })
		expect(result.current.models).toEqual(models)
		expect(result.current.status).toBe("success")
	})

	it.each(["baseUrl", "apiKey"])("clears results and rejects old replies after %s changes", (field) => {
		const { result, rerender } = renderHook(({ baseUrl, apiKey }) => useLiteLLMModels(true, baseUrl, apiKey), {
			initialProps: { baseUrl: "https://draft.test", apiKey: "key" },
		})
		act(() => vi.advanceTimersByTime(300))
		const oldId = lastRequest().requestId
		reply({ type: "liteLLMModels", requestId: oldId, liteLLMModels: models })
		rerender({
			baseUrl: "https://draft.test",
			apiKey: "key",
			[field]: field === "baseUrl" ? "https://new.test" : "new-key",
		})
		expect(result.current.models).toEqual({})
		reply({ type: "liteLLMModels", requestId: oldId, error: "old failure" })
		expect(result.current.status).toBe("idle")
		act(() => vi.advanceTimersByTime(300))
		expect(lastRequest().requestId).not.toBe(oldId)
	})

	it.each([false, true])("replaces prior results on empty or failed refresh (failure=%s)", (failure) => {
		const { result } = renderHook(() => useLiteLLMModels(true, "https://draft.test", "key"))
		act(() => result.current.refresh())
		reply({ type: "liteLLMModels", requestId: lastRequest().requestId, liteLLMModels: models })
		act(() => result.current.refresh())
		expect(result.current.models).toEqual({})
		reply({
			type: "liteLLMModels",
			requestId: lastRequest().requestId,
			liteLLMModels: {},
			...(failure ? { error: "HTTP 400" } : {}),
		})
		expect(result.current.status).toBe(failure ? "error" : "success")
		expect(result.current.models).toEqual({})
		expect(result.current.error).toBe(failure ? "HTTP 400" : undefined)
	})

	it("times out and ignores late completion", () => {
		const { result } = renderHook(() => useLiteLLMModels(true, "https://draft.test", "key"))
		act(() => result.current.refresh())
		const requestId = lastRequest().requestId
		act(() => vi.advanceTimersByTime(10000))
		expect(result.current.error).toContain("timed out")
		reply({ type: "liteLLMModels", requestId, liteLLMModels: models })
		expect(result.current.models).toEqual({})
	})

	it("does not fetch incomplete or inactive forms and clears on provider switch", () => {
		const { result, rerender } = renderHook(
			({ enabled, apiKey }) => useLiteLLMModels(enabled, "https://draft.test", apiKey),
			{ initialProps: { enabled: true, apiKey: "" } },
		)
		act(() => vi.advanceTimersByTime(300))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		rerender({ enabled: true, apiKey: "key" })
		act(() => vi.advanceTimersByTime(300))
		const requestId = lastRequest().requestId
		rerender({ enabled: false, apiKey: "key" })
		reply({ type: "liteLLMModels", requestId, liteLLMModels: models })
		expect(result.current.status).toBe("idle")
		expect(result.current.models).toEqual({})
	})
})
