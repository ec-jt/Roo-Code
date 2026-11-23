import * as vscode from "vscode"
import { t } from "../../i18n"
import type { ClineProvider } from "./ClineProvider"
import { taskStateNativeRequestSchema, type TaskStateNativeResponse } from "../../../packages/types/src/task-state"
import { taskStateTransaction, assertTaskStateAccess } from "../../services/task-state/taskState"
import { renderTaskState } from "../../services/task-state/render"
import { getTaskStateStore } from "../../services/task-state/TaskStateStore"
import { taskHistoryAnchors } from "../../services/task-state/history"
import {
	continuationView,
	resetTaskContinuation,
	startTaskContinuation,
	stopTaskContinuation,
	attestTaskCheck,
	persistContinuationStop,
} from "../../services/task-state/continuation"

/** Native entry point. Webview payloads are validated and destructive/consent actions receive native confirmation. */
export async function handleTaskStateRequest(provider: ClineProvider, raw: unknown): Promise<void> {
	const parsed = taskStateNativeRequestSchema.safeParse(raw)
	if (!parsed.success) {
		// Never fail silently. Without a valid requestId the panel cannot correlate a reply,
		// so log it; the panel's own timeout then surfaces the failure to the user.
		provider.log(`[taskState] Rejected malformed task-state request: ${parsed.error.issues.length} issue(s)`)
		return
	}
	const request = parsed.data
	const response: TaskStateNativeResponse = { requestId: request.requestId, taskId: request.taskId }
	try {
		const task = provider.getCurrentTask()
		if (!task || task.taskId !== request.taskId) throw new Error("The requested task is no longer current")
		if (request.action === "stop") stopTaskContinuation(task)
		const { store, options } = await taskStateTransaction(task, request.expectedRevision)
		let state = await store.read(options.validHistoryAnchors)
		if (request.action === "stop") await persistContinuationStop(task)
		const mutating = !["read", "export", "stop"].includes(request.action)
		if (mutating && state.revision !== request.expectedRevision)
			throw new Error("Task state changed; refresh before retrying")
		// The user's own enable (initialize) only needs the current open task: it can create a ledger
		// only where none exists, so it never alters an in-flight request. Everything else stays idle-only.
		const assertAllowed = () =>
			request.action === "initialize" ? task.assertTaskStateEnableAllowed() : task.assertTaskStateNativeAllowed()
		if (mutating) {
			assertAllowed()
			if (request.action === "fresh-context") {
				await task.createReviewedTaskStateContext(request.expectedRevision!)
			} else {
				const detail = JSON.stringify(
					{
						taskId: task.taskId,
						cwd: task.cwd,
						revision: state.revision,
						action: request.action,
						operations: request.operations,
						policy: request.policy,
						check: request.check,
						source: request.source,
						state: state.snapshot?.data,
						historyWarning:
							state.revision && !state.snapshot
								? "No stored revision matches this history. Native correction/configuration starts empty state at the current history; old revisions are retained, not imported."
								: undefined,
						note: "Task-local data only. Model claims are not verification. Acceptance checks are user-attested descriptions, never executable commands. Start arms bounded continuation for the next ordinary turn; it does not dispatch work. Existing tool permissions and mandatory approvals remain unchanged.",
					},
					null,
					2,
				)
				const answer = await vscode.window.showWarningMessage(
					"Review task-state action",
					{ modal: true, detail },
					"Approve task-state action",
				)
				if (answer !== "Approve task-state action") throw new Error("Task-state action cancelled")
				await options.authorize()
				assertAllowed()
				if ((await store.read(options.validHistoryAnchors)).revision !== request.expectedRevision)
					throw new Error("Task state changed during review")
				switch (request.action) {
					case "initialize":
						state = await store.initialize({ ...options, operations: request.operations })
						// L1 defect 4: never report an enable that left no ledger.
						if (!state.revision || !(await store.read(options.validHistoryAnchors)).revision)
							throw new Error("No task-state ledger was written")
						break
					case "fork": {
						if (!request.source) throw new Error("Fork requires an explicit source task and revision")
						const source = await provider.getTaskWithId(request.source.taskId)
						if (!source.historyItem.workspace || source.historyItem.workspace !== task.cwd)
							throw new Error("Fork source must belong to the same workspace")
						const sourceStore = getTaskStateStore({
							taskDir: source.taskDirPath,
							taskId: request.source.taskId,
							cwd: source.historyItem.workspace,
						})
						assertTaskStateAccess(task, sourceStore)
						state = await store.forkFrom({
							...options,
							source: sourceStore,
							sourceRevision: request.source.revision,
							sourceValidHistoryAnchors: taskHistoryAnchors(source.apiConversationHistory).anchors,
							authorize: async () => {
								await options.authorize()
								assertTaskStateAccess(task, sourceStore)
							},
						})
						break
					}
					case "correct":
						if (!request.operations) throw new Error("Correction requires operations")
						state = await store.correct({ ...options, operations: request.operations })
						break
					case "configure":
						if (!request.policy) throw new Error("Configuration requires policy")
						if (request.policy.enabled && !request.policy.checks.length)
							throw new Error("Continuation requires concrete user-attested check definitions")
						stopTaskContinuation(task, "configured")
						state = await store.configurePolicy({ ...options, policy: request.policy })
						await resetTaskContinuation(task)
						break
					case "disable":
						stopTaskContinuation(task, "disabled")
						state = await store.configurePolicy({
							...options,
							policy: { ...state.policy, recallEnabled: false, enabled: false },
						})
						break
					case "start":
						await startTaskContinuation(task)
						break
					case "attest":
						if (!request.check) throw new Error("Attestation requires an approved check and note")
						await attestTaskCheck(task, request.check)
						break
				}
			}
		}
		const history = taskHistoryAnchors(task.apiConversationHistory)
		Object.assign(response, state, {
			history: { anchor: history.anchor, position: history.position },
			runtime: await continuationView(task),
		})
		if (request.action === "export") response.exportText = renderTaskState(state.snapshot)
	} catch (error) {
		response.error = error instanceof Error ? error.message : "Task-state action failed"
		provider.log(`[taskState] ${request.action} failed for task ${request.taskId}: ${response.error}`)
		// L1 defect 4: an enable can fail after the panel switched to another task (for example an
		// Orchestrator child started), and then the panel drops the reply. Show the failure natively.
		if (request.action === "initialize" && response.error !== "Task-state action cancelled") {
			void vscode.window.showErrorMessage(
				t("common:errors.task_state_enable_failed", { taskId: request.taskId, error: response.error }),
			)
		}
	}
	await provider.postMessageToWebview({ type: "taskStateResponse", taskStateResponse: response })
}
