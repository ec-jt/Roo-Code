import type { Task } from "../task/Task"
import type { ToolCallbacks } from "./BaseTool"

const EXECUTION_TIMEOUT_MS = 60_000

/** Bound execution, not approval. Only this caller may publish the operation's result. */
export async function runReadOnlyTool(
	name: string,
	task: Task,
	callbacks: ToolCallbacks,
	operation: (signal: AbortSignal) => Promise<string>,
): Promise<void> {
	const controller = new AbortController()
	const isClosed = () => task.abort || task.abandoned || task.modelOperationDispatchClosed
	if (isClosed()) return

	const timeout = setTimeout(() => {
		controller.abort(
			new Error(`${name} timed out after 60 seconds. The underlying operation may still be stopping.`),
		)
	}, EXECUTION_TIMEOUT_MS)
	const cancellation = setInterval(() => {
		if (isClosed()) controller.abort(new Error(`${name} cancelled`))
	}, 100)
	let onAbort!: () => void
	const stopped = new Promise<never>((_, reject) => {
		onAbort = () => reject(controller.signal.reason)
		controller.signal.addEventListener("abort", onAbort, { once: true })
	})

	try {
		const result = await Promise.race([operation(controller.signal), stopped])
		if (!isClosed()) callbacks.pushToolResult(result)
	} catch (error) {
		if (!isClosed()) {
			task.didToolFailInCurrentTurn = true
			await callbacks.handleError(`executing ${name}`, error instanceof Error ? error : new Error(String(error)))
		}
	} finally {
		clearTimeout(timeout)
		clearInterval(cancellation)
		controller.signal.removeEventListener("abort", onAbort)
	}
}
