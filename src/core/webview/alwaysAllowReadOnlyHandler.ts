import type { WebviewMessage } from "@roo-code/types"
import { canAlwaysAllowReadOnly } from "../../shared/toolApproval"
import type { ClineProvider } from "./ClineProvider"

/** Persist only the Read permission, and answer only the exact ask the user selected. */
export async function handleAlwaysAllowReadOnlyAsk(
	provider: Pick<ClineProvider, "getCurrentTask" | "contextProxy" | "postStateToWebview">,
	request: WebviewMessage["alwaysAllowReadOnlyAsk"],
): Promise<void> {
	if (!request) return
	const task = provider.getCurrentTask()
	if (!task) return
	const isCurrent = () => {
		const operation = task.modelOperationState
		return (
			provider.getCurrentTask() === task &&
			task.taskId === request.taskId &&
			task.instanceId === request.instanceId &&
			operation.revision === request.revision &&
			!operation.requiresToolApproval &&
			!operation.approval &&
			(provider.contextProxy.getValue("autoApprovalEnabled") === true ||
				provider.contextProxy.getValue("alwaysAllowAll") !== true) &&
			task.isPendingToolAsk(request.askTs) &&
			canAlwaysAllowReadOnly(
				task.clineMessages.at(-1),
				provider.contextProxy.getValue("alwaysAllowReadOnlyOutsideWorkspace") === true,
			)
		)
	}
	if (!isCurrent()) return
	await provider.contextProxy.setValues({ autoApprovalEnabled: true, alwaysAllowReadOnly: true })
	// Settings persistence is asynchronous: never redirect an approval to a newer ask or task.
	if (isCurrent()) task.handleWebviewAskResponse("yesButtonClicked")
	await provider.postStateToWebview()
}
