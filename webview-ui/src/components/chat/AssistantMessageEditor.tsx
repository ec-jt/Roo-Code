import { useEffect, useRef, useState } from "react"
import type { AssistantMessageEdit, ClineMessage, ExtensionMessage } from "@roo-code/types"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { Button } from "@/components/ui"
import { vscode } from "@/utils/vscode"
import { isChatPreview } from "@roo/chat-preview"

/** History-only edits. Never routes through the user-message send or rewind flow. */
export function AssistantMessageEditor({ message, isStreaming }: { message: ClineMessage; isStreaming: boolean }) {
	const { chatWindow, clineMessages, runningTask } = useExtensionState()
	if (
		!chatWindow ||
		!chatWindow.following ||
		runningTask?.background ||
		isStreaming ||
		message.partial ||
		message.type !== "say" ||
		message.say !== "text" ||
		!message.text ||
		clineMessages[0]?.ts === message.ts ||
		isChatPreview(message, chatWindow)
	)
		return null
	return (
		<Editor
			key={`${chatWindow.taskId}:${chatWindow.instanceId}:${message.ts}`}
			message={message}
			taskId={chatWindow.taskId}
			instanceId={chatWindow.instanceId}
		/>
	)
}

function Editor({ message, taskId, instanceId }: { message: ClineMessage; taskId: string; instanceId: string }) {
	const [open, setOpen] = useState(false)
	const [draft, setDraft] = useState("")
	const [original, setOriginal] = useState("")
	const [saving, setSaving] = useState(false)
	const [uncertain, setUncertain] = useState(false)
	const [error, setError] = useState<string>()
	const [saved, setSaved] = useState(false)
	const pending = useRef<AssistantMessageEdit>()
	const timer = useRef<ReturnType<typeof setTimeout>>()

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const result = event.data.assistantMessageEditResult
			const request = pending.current
			if (
				event.data.type !== "assistantMessageEditResult" ||
				!result ||
				!request ||
				result.operationId !== request.operationId ||
				result.taskId !== taskId ||
				result.instanceId !== instanceId ||
				result.ts !== message.ts
			)
				return
			clearTimeout(timer.current)
			pending.current = undefined
			setSaving(false)
			setUncertain(false)
			if (result.success) {
				setOpen(false)
				setSaved(true)
			} else {
				setError(result.error || "The assistant edit could not be saved.")
			}
		}
		window.addEventListener("message", onMessage)
		return () => {
			window.removeEventListener("message", onMessage)
			clearTimeout(timer.current)
		}
	}, [taskId, instanceId, message.ts])

	const start = () => {
		pending.current = undefined
		setDraft(message.text ?? "")
		setOriginal(message.text ?? "")
		setError(undefined)
		setSaved(false)
		setUncertain(false)
		setOpen(true)
	}
	const save = () => {
		if (saving || uncertain || !draft.trim() || draft === original || message.text !== original) return
		const request: AssistantMessageEdit = {
			operationId: crypto.randomUUID(),
			taskId,
			instanceId,
			ts: message.ts,
			expectedText: original,
			text: draft,
		}
		pending.current = request
		setError(undefined)
		setSaving(true)
		timer.current = setTimeout(() => {
			setSaving(false)
			setUncertain(true)
			setError(
				"Save acknowledgement was not received. Your draft is preserved. Reopen the task to check its stored response before retrying.",
			)
		}, 30_000)
		vscode.postMessage({ type: "editAssistantMessage", assistantMessageEdit: request })
	}

	if (!open)
		return (
			<div className="flex items-center gap-2 mt-1">
				<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={start}>
					Edit assistant response
				</Button>
				{saved && (
					<span role="status" className="text-xs text-vscode-descriptionForeground">
						Saved. Nothing was run.
					</span>
				)}
			</div>
		)

	return (
		<section className="mt-2 space-y-2" aria-label="Edit assistant response">
			<p className="text-xs text-vscode-descriptionForeground">
				Change stored assistant text only. Later messages and completed actions stay unchanged. Nothing runs
				when you save. The next request uses the edited history, not an assistant-prefill continuation.
			</p>
			<textarea
				aria-label="Assistant response text"
				value={draft}
				disabled={saving}
				maxLength={1_000_000}
				onChange={(event) => setDraft(event.target.value)}
				rows={8}
				className="w-full box-border resize-y rounded border border-vscode-panel-border bg-vscode-input-background text-vscode-input-foreground p-2 font-mono text-sm"
			/>
			{message.text !== original && !saving && (
				<p role="alert">The stored response changed. Close and reopen the editor before saving.</p>
			)}
			{error && (
				<p role="alert" className="text-sm">
					{error}
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button variant="secondary" size="sm" disabled={saving} onClick={() => setOpen(false)}>
					Cancel
				</Button>
				<Button
					size="sm"
					disabled={saving || uncertain || !draft.trim() || draft === original || message.text !== original}
					onClick={save}>
					{saving ? "Saving..." : "Save without running"}
				</Button>
			</div>
		</section>
	)
}
