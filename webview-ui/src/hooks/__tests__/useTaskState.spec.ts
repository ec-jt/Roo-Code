import { act, renderHook } from "@testing-library/react"
import type { TaskStateNativeRequest, TaskStateNativeResponse } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"
import { TASK_STATE_TIMEOUT_MS, useTaskState } from "../useTaskState"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

function lastRequest(): TaskStateNativeRequest {
	return vi.mocked(vscode.postMessage).mock.calls.at(-1)![0].taskStateRequest!
}
function reply(request: TaskStateNativeRequest, extra: Partial<TaskStateNativeResponse> = {}) {
	act(() =>
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "taskStateResponse",
					taskStateResponse: {
						requestId: request.requestId,
						taskId: request.taskId,
						revision: "a".repeat(64),
						...extra,
					},
				},
			}),
		),
	)
}

describe("useTaskState", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubGlobal("acquireVsCodeApi", vi.fn())
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("matches both request and task, ignores duplicates, and sends ledger-head CAS", async () => {
		const { result } = renderHook(() => useTaskState("task-a"))
		act(() => {
			void result.current.request({ action: "read" })
		})
		const read = lastRequest()
		expect(read.requestId).toMatch(/^[a-f0-9-]{36}$/)
		reply(read, { requestId: "other" })
		reply(read, { taskId: "task-b" })
		expect(result.current.response).toBeUndefined()
		reply(read)
		expect(result.current.response?.revision).toBe("a".repeat(64))
		reply(read, { revision: "b".repeat(64) })
		act(() => {
			void result.current.request({
				action: "correct",
				operations: [{ op: "set", field: "goal", value: "reviewed" }],
			})
		})
		expect(lastRequest().expectedRevision).toBe("a".repeat(64))
	})

	it("clears state and pending requests on task switch and rejects old responses", async () => {
		const { result, rerender, unmount } = renderHook(({ taskId }) => useTaskState(taskId), {
			initialProps: { taskId: "a" },
		})
		let pending: ReturnType<typeof result.current.request>
		act(() => {
			pending = result.current.request({ action: "read" })
		})
		const old = lastRequest()
		rerender({ taskId: "b" })
		expect(await pending!).toBeUndefined()
		reply(old)
		expect(result.current.response).toBeUndefined()
		act(() => {
			void result.current.request({ action: "read" })
		})
		expect(lastRequest().taskId).toBe("b")
		expect(lastRequest().expectedRevision).toBeNull()
		unmount()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("requires a read after timeout and ignores late responses", async () => {
		const { result } = renderHook(() => useTaskState("a"))
		act(() => {
			void result.current.request({ action: "read" })
		})
		const old = lastRequest()
		act(() => vi.advanceTimersByTime(TASK_STATE_TIMEOUT_MS))
		expect(result.current.error).toContain("timed out")
		reply(old)
		expect(result.current.response).toBeUndefined()
		act(() => {
			void result.current.request({ action: "initialize" })
		})
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		act(() => {
			void result.current.request({ action: "read" })
		})
		reply(lastRequest(), { revision: null })
		expect(result.current.needsRefresh).toBe(false)
	})

	it("stop supersedes pending review without accepting its later response", async () => {
		const { result } = renderHook(() => useTaskState("a"))
		act(() => {
			void result.current.request({ action: "read" })
		})
		reply(lastRequest())
		act(() => {
			void result.current.request({ action: "start" })
		})
		const start = lastRequest()
		act(() => {
			void result.current.request({ action: "stop" })
		})
		const stop = lastRequest()
		expect(stop.action).toBe("stop")
		reply(start, { revision: "b".repeat(64) })
		expect(result.current.busy).toBe(true)
		reply(stop)
		expect(result.current.busy).toBe(false)
		expect(result.current.response?.requestId).toBe(stop.requestId)
	})

	it("does not send sensitive payloads to the browser logging fallback", async () => {
		vi.stubGlobal("acquireVsCodeApi", undefined)
		const { result } = renderHook(() => useTaskState("a"))
		await act(async () => {
			await result.current.request({ action: "read" })
		})
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(result.current.error).toContain("extension host")
	})
})
