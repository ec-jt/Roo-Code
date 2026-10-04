import type { ClineMessage } from "@roo-code/types"
import { canAlwaysAllowReadOnly } from "@roo/toolApproval"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button, StandardTooltip } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

export function AlwaysAllowReadOnlyButton({ message }: { message: ClineMessage | undefined }) {
	const { modelOperation, currentTaskId, alwaysAllowReadOnlyOutsideWorkspace, autoApprovalEnabled, alwaysAllowAll } =
		useExtensionState()
	const { t } = useAppTranslation()
	if (
		!modelOperation ||
		modelOperation.taskId !== currentTaskId ||
		modelOperation.requiresToolApproval ||
		modelOperation.approval ||
		(!autoApprovalEnabled && alwaysAllowAll) ||
		!canAlwaysAllowReadOnly(message, alwaysAllowReadOnlyOutsideWorkspace)
	) {
		return null
	}
	return (
		<div className="px-[15px] mb-2">
			<StandardTooltip content={t("settings:autoApprove.readOnly.description")}>
				<Button
					variant="secondary"
					className="w-full"
					onClick={() => {
						vscode.postMessage({
							type: "alwaysAllowReadOnlyAsk",
							alwaysAllowReadOnlyAsk: {
								taskId: modelOperation.taskId,
								instanceId: modelOperation.instanceId,
								revision: modelOperation.revision,
								askTs: message!.ts,
							},
						})
					}}>
					{t("settings:autoApprove.readOnly.alwaysAllow")}
				</Button>
			</StandardTooltip>
		</div>
	)
}
