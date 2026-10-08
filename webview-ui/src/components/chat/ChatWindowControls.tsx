import type { ChatWindowState, ClineMessage } from "@roo-code/types"
import { Button } from "@/components/ui"
import { vscode } from "@/utils/vscode"

// English fallback labels until the bounded-history UI is localized.
export function ChatWindowControls({ window }: { window: ChatWindowState }) {
	const request = (cursor: { before?: number; after?: number; latest?: boolean }) =>
		vscode.postMessage({
			type: "chatWindowRequest",
			chatWindowRequest: {
				taskId: window.taskId,
				instanceId: window.instanceId,
				revision: window.revision,
				...cursor,
			},
		})
	return (
		<div className="px-3 py-2 text-xs border-b border-vscode-panel-border" aria-label="Conversation pages">
			<div role="status">
				{window.endIndex > window.startIndex ? `${window.startIndex + 1}-${window.endIndex}` : "0"} of{" "}
				{window.totalMessages} messages (task prompt pinned)
			</div>
			<div className="flex flex-wrap gap-2 mt-1">
				<Button
					size="sm"
					variant="secondary"
					disabled={!window.hasOlder}
					onClick={() => request({ before: window.startIndex })}>
					Older
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!window.hasNewer}
					onClick={() => request({ after: window.endIndex })}>
					Newer
				</Button>
				{!window.following && (
					<Button size="sm" onClick={() => request({ latest: true })}>
						Return to latest
					</Button>
				)}
			</div>
			{!window.following && (
				<p>Read-only history. Return to latest to send messages or approve actions. Your draft is preserved.</p>
			)}
			{window.reason === "staleRevision" && (
				<p role="status">History changed. The current page was refreshed. Try navigation again.</p>
			)}
			{window.oversizedLiveAsk && (
				<p role="status">
					This approval contains a large message. Its authorization details are shown in full.
				</p>
			)}
		</div>
	)
}

export function PlainHistoryMessage({ message, window }: { message: ClineMessage; window: ChatWindowState }) {
	return (
		<div className="p-3 border-b border-vscode-panel-border" data-testid="plain-history-message">
			<div className="text-xs text-vscode-descriptionForeground">
				{message.ask ?? message.say ?? message.type}
				{window.truncatedTs.includes(message.ts) ? " (preview)" : ""}
			</div>
			<pre className="whitespace-pre-wrap break-words text-xs font-mono max-h-80 overflow-auto">
				{message.text}
				{message.reasoning ? `\n\n${message.reasoning}` : ""}
			</pre>
			<Button
				size="sm"
				variant="secondary"
				onClick={() =>
					vscode.postMessage({
						type: "chatMessageOpen",
						chatMessageOpen: {
							taskId: window.taskId,
							instanceId: window.instanceId,
							ts: message.ts,
						},
					})
				}>
				Open full message
			</Button>
		</div>
	)
}
