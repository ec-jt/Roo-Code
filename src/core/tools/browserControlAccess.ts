import type { Task } from "../task/Task"
import type { ToolUse } from "../../shared/tools"
import { validateToolUse } from "./validateToolUse"
import { defaultModeSlug } from "../../shared/modes"

const busy = new WeakSet<Task>()
export function acquireBrowserControl(task: Task): () => void {
	if (busy.has(task)) throw new Error("Another browser control request is pending.")
	busy.add(task)
	return () => busy.delete(task)
}

/** Fence all asynchronous approval/settings boundaries against task and session replacement. */
export function browserControlFence(task: Task, idle = false) {
	const provider = task.providerRef.deref()
	const revision = task.modelOperationState.revision
	const initial = task.browserSession.getControlState()
	const assert = (selection = true, session = true) => {
		if (
			!provider ||
			provider.getCurrentTask() !== task ||
			provider.isTaskBackgrounded ||
			provider.isChatWindowFollowing?.() === false ||
			task.abort ||
			task.abandoned ||
			task.modelOperationDispatchClosed ||
			task.isAssistantMessageEditing ||
			task.modelOperationState.revision !== revision
		)
			throw new Error("Browser request is stale or the task is not foreground.")
		if (idle) task.assertTaskStateNativeAllowed()
		const current = task.browserSession.getControlState()
		if (
			(session && current.sessionId !== initial.sessionId) ||
			(selection && (current.generation !== initial.generation || current.tabId !== initial.tabId))
		)
			throw new Error("Browser session changed. Refresh before retrying.")
	}
	const authorize = async (block?: ToolUse) => {
		assert()
		const state = await provider!.getState()
		assert()
		validateToolUse(
			"browser_action",
			state.mode ?? defaultModeSlug,
			state.customModes ?? [],
			Object.fromEntries((state.disabledTools ?? []).map((tool) => [tool, false])),
		)
		if (block) {
			const decision = await task.checkToolInvocation(block)
			assert()
			if (!decision.allow) throw new Error("Browser tool invocation is no longer allowed.")
		}
	}
	assert()
	return { assert, authorize, initial }
}
