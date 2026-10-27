import { useCallback, useEffect, useRef, useState } from "react"
import type { ExtensionMessage, TaskStateNativeRequest, TaskStateNativeResponse } from "@roo-code/types"
import { taskStateNativeRequestSchema } from "@roo-code/types"
import { vscode } from "@src/utils/vscode"

export const TASK_STATE_TIMEOUT_MS = 120_000
type RequestInput = Omit<TaskStateNativeRequest, "requestId" | "taskId" | "expectedRevision">
type Pending = {
	action: TaskStateNativeRequest["action"]
	requestId: string
	taskId: string
	timer: ReturnType<typeof setTimeout>
	resolve: (response: TaskStateNativeResponse | undefined) => void
}

/** One outstanding request, correlated to both task and request. Stop can supersede a pending request. */
export function useTaskState(taskId: string) {
	const [response, setResponse] = useState<TaskStateNativeResponse>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [needsRefresh, setNeedsRefresh] = useState(false)
	const pending = useRef<Pending>()
	const currentTask = useRef(taskId)
	currentTask.current = taskId
	const revision = useRef<string | null>(null)
	const loaded = useRef(false)
	const refreshRequired = useRef(false)

	const cancelPending = useCallback(() => {
		if (pending.current) {
			clearTimeout(pending.current.timer)
			pending.current.resolve(undefined)
			pending.current = undefined
		}
	}, [])

	useEffect(() => {
		revision.current = null
		loaded.current = false
		refreshRequired.current = false
		setResponse(undefined)
		setError(undefined)
		setBusy(false)
		setNeedsRefresh(false)
		return cancelPending
	}, [taskId, cancelPending])

	useEffect(() => {
		const receive = (event: MessageEvent<ExtensionMessage>) => {
			const reply = event.data?.taskStateResponse
			const request = pending.current
			if (
				event.data?.type !== "taskStateResponse" ||
				!reply ||
				!request ||
				reply.requestId !== request.requestId ||
				reply.taskId !== request.taskId ||
				reply.taskId !== currentTask.current
			)
				return
			clearTimeout(request.timer)
			pending.current = undefined
			setBusy(false)
			if (reply.error) {
				setError(reply.error)
				refreshRequired.current = true
				setNeedsRefresh(true)
				request.resolve(undefined)
				return
			}
			if (reply.revision !== undefined) {
				revision.current = reply.revision
				loaded.current = true
			}
			if (request.action === "read") {
				refreshRequired.current = false
				setNeedsRefresh(false)
			}
			setError(undefined)
			setResponse(reply)
			request.resolve(reply)
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [])

	const request = useCallback(
		(input: RequestInput): Promise<TaskStateNativeResponse | undefined> => {
			if (currentTask.current !== taskId) return Promise.resolve(undefined)
			if (pending.current && input.action !== "stop") return Promise.resolve(undefined)
			if (!["read", "export", "stop"].includes(input.action) && (!loaded.current || refreshRequired.current)) {
				setError("Refresh task state before reviewing and retrying this action. Your draft is retained.")
				return Promise.resolve(undefined)
			}
			// The shared development fallback logs full messages. Never send task data through that fallback.
			if (typeof acquireVsCodeApi !== "function") {
				setError("Task state requires the VS Code extension host.")
				return Promise.resolve(undefined)
			}
			const parsed = taskStateNativeRequestSchema.safeParse({
				...input,
				taskId,
				requestId: crypto.randomUUID(),
				expectedRevision: revision.current,
			})
			if (!parsed.success) {
				setError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))
				return Promise.resolve(undefined)
			}
			cancelPending()
			setBusy(true)
			setError(undefined)
			return new Promise((resolve) => {
				const timer = setTimeout(() => {
					if (pending.current?.requestId !== parsed.data.requestId) return
					pending.current = undefined
					setBusy(false)
					refreshRequired.current = true
					setNeedsRefresh(true)
					setError(
						"Task-state request timed out. It may still finish in the extension. Refresh before retrying; your draft is retained.",
					)
					resolve(undefined)
				}, TASK_STATE_TIMEOUT_MS)
				pending.current = { action: input.action, requestId: parsed.data.requestId, taskId, timer, resolve }
				try {
					vscode.postMessage({ type: "taskStateRequest", taskStateRequest: parsed.data })
				} catch {
					cancelPending()
					setBusy(false)
					refreshRequired.current = true
					setNeedsRefresh(true)
					setError("Could not send task-state request. Refresh before retrying.")
				}
			})
		},
		[taskId, cancelPending],
	)

	return { response: response?.taskId === taskId ? response : undefined, error, busy, needsRefresh, request }
}
