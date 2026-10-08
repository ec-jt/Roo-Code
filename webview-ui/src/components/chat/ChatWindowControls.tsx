import { useState } from "react"
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
	const pageLabel = `${window.endIndex > window.startIndex ? `${window.startIndex + 1}-${window.endIndex}` : "0"} of ${window.totalMessages} messages (task prompt pinned)`
	return (
		<div className="px-3 py-1 text-xs border-b border-vscode-panel-border" aria-label="Conversation pages">
			<div className="flex items-center gap-2 min-w-0">
				<div className="min-w-0 flex-1 truncate" role="status" title={pageLabel}>
					{pageLabel}
				</div>
				<div className="ml-auto flex shrink-0 items-center justify-end gap-1">
					<Button
						size="sm"
						className="h-6 px-2 text-xs"
						variant="secondary"
						disabled={!window.hasOlder}
						onClick={() => request({ before: window.startIndex })}>
						Older
					</Button>
					<Button
						size="sm"
						className="h-6 px-2 text-xs"
						variant="secondary"
						disabled={!window.hasNewer}
						onClick={() => request({ after: window.endIndex })}>
						Newer
					</Button>
					{!window.following && (
						<Button size="sm" className="h-6 px-2 text-xs" onClick={() => request({ latest: true })}>
							Return to latest
						</Button>
					)}
				</div>
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
	const [expanded, setExpanded] = useState(false)
	const isToolPreview =
		["tool", "command", "use_mcp_server"].includes(message.ask ?? "") ||
		["tool", "command_output", "browser_action_result", "user_feedback_diff"].includes(message.say ?? "")
	const isLiveApproval =
		window.following && window.liveMessage?.ts === message.ts && message.type === "ask" && !message.isAnswered
	const compact = isToolPreview && !isLiveApproval
	return (
		<div className="px-3 py-1 border-b border-vscode-panel-border" data-testid="plain-history-message">
			<div className="flex items-center justify-between gap-2">
				<div className="text-xs text-vscode-descriptionForeground">
					{message.ask ?? message.say ?? message.type}
					{window.truncatedTs.includes(message.ts) ? " (preview)" : ""}
				</div>
				<div className="flex items-center gap-1">
					{compact && (
						<Button
							size="sm"
							variant="secondary"
							className="h-6 px-2 text-xs"
							aria-expanded={expanded}
							onClick={() => setExpanded(!expanded)}>
							{expanded ? "Hide preview" : "Show preview"}
						</Button>
					)}
					<Button
						size="sm"
						variant="secondary"
						className="h-6 px-2 text-xs"
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
			</div>
			{(!compact || expanded) && (
				<pre className="whitespace-pre-wrap break-words text-xs font-mono max-h-80 overflow-auto">
					{message.text}
					{message.reasoning ? `\n\n${message.reasoning}` : ""}
				</pre>
			)}
		</div>
	)
}
