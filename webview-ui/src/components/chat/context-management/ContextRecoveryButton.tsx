import { Button } from "@/components/ui"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

export function ContextRecoveryButton({ eventId }: { eventId?: string }) {
	return eventId ? <RecoveryAction eventId={eventId} /> : null
}

function RecoveryAction({ eventId }: { eventId: string }) {
	const { chatWindow, runningTask } = useExtensionState()
	if (!eventId || !chatWindow || runningTask?.background) return null
	return (
		<Button
			variant="ghost"
			size="sm"
			className="mt-1 h-6 px-2 text-xs"
			onClick={() => {
				vscode.postMessage({
					type: "contextRecoveryBranch",
					contextRecoveryBranch: {
						taskId: chatWindow.taskId,
						instanceId: chatWindow.instanceId,
						eventId,
					},
				})
			}}>
			Recover in new branch…
		</Button>
	)
}
