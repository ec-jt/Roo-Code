import { useEffect, useState } from "react"
import type { ChatWindowState, ClineMessage, ExtensionMessage } from "@roo-code/types"
import { Button } from "@/components/ui"
import { vscode } from "@/utils/vscode"
import Thumbnails from "../common/Thumbnails"

/**
 * Inline editor for one stored user message. It retrieves the authoritative stored text
 * and attachments before editing, so a truncated preview prefix is never treated as the
 * whole message and the tail or images are never lost. Saving posts the existing
 * `submitEditedMessage` request, which keeps the confirmation dialog and the
 * rewind/resubmit behaviour the user already knows. Edits apply only while the latest
 * page is shown; the backend rejects the request on a historical or switched task.
 */
export function UserMessageEditor({
	message,
	window: chatWindow,
	onClose,
}: {
	message: ClineMessage
	window: ChatWindowState
	onClose: () => void
}) {
	const index = message.chatPreview?.index
	const [request] = useState(() => {
		if (typeof index !== "number") return undefined
		return {
			taskId: chatWindow.taskId,
			instanceId: chatWindow.instanceId,
			ts: message.ts,
			index,
			revision: chatWindow.revision,
		}
	})
	const stale =
		!request ||
		request.taskId !== chatWindow.taskId ||
		request.instanceId !== chatWindow.instanceId ||
		request.revision !== chatWindow.revision

	const [text, setText] = useState("")
	const [images, setImages] = useState<string[]>([])
	const [loading, setLoading] = useState(request !== undefined)
	const [error, setError] = useState<string | undefined>(
		request ? undefined : "This entry has no addressable history index, so it cannot be edited here.",
	)

	useEffect(() => {
		if (!request) return
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const data = event.data.chatMessageEditData
			if (event.data.type !== "chatMessageEditData" || !data) return
			if (
				data.taskId !== request.taskId ||
				data.instanceId !== request.instanceId ||
				data.ts !== request.ts ||
				data.index !== request.index ||
				data.revision !== request.revision
			)
				return
			clearTimeout(timer)
			setLoading(false)
			if (data.error) {
				setError(data.error)
				return
			}
			if (data.tooLarge) {
				setError(
					"This message or its attachments are too large to edit inline. Open the full message, or delete it and resend instead.",
				)
				return
			}
			setError(undefined)
			setText(data.text ?? "")
			setImages(data.images ?? [])
		}
		window.addEventListener("message", onMessage)
		const timer = setTimeout(() => {
			setLoading(false)
			setError("The full message did not load. Close and reopen the editor to try again.")
		}, 20_000)
		vscode.postMessage({ type: "chatMessageEdit", chatMessageEdit: request })
		return () => {
			window.removeEventListener("message", onMessage)
			clearTimeout(timer)
		}
	}, [request])

	const save = () => {
		if (!canSave) return
		vscode.postMessage({
			type: "submitEditedMessage",
			value: message.ts,
			editedMessageContent: text,
			images,
			taskId: chatWindow.taskId,
			instanceId: chatWindow.instanceId,
			chatMessageEdit: request,
		})
		onClose()
	}

	const canSave = !stale && !loading && !error && text.trim().length > 0

	return (
		<section className="mt-1 space-y-2" aria-label="Edit your message">
			<p className="text-xs text-vscode-descriptionForeground">
				Editing this message discards all later messages in this conversation and resumes the task from this
				point. Confirm in the dialog that appears.
			</p>
			{loading ? (
				<p role="status" className="text-xs text-vscode-descriptionForeground">
					Loading the full message...
				</p>
			) : (
				<>
					<textarea
						aria-label="Your message text"
						value={text}
						disabled={!!error}
						onChange={(event) => setText(event.target.value)}
						rows={6}
						className="w-full box-border resize-y rounded border border-vscode-panel-border bg-vscode-input-background text-vscode-input-foreground p-2 font-mono text-sm"
					/>
					{images.length > 0 && (
						<>
							<Thumbnails images={images} />
							<p className="text-xs text-vscode-descriptionForeground">
								Existing attachments are kept when you save.
							</p>
						</>
					)}
				</>
			)}
			{error && (
				<p role="alert" className="text-sm">
					{error}
				</p>
			)}
			{stale && (
				<p role="alert">
					History changed while editing. Your draft is preserved here; copy it before closing and reopening
					the editor.
				</p>
			)}
			<div className="flex justify-end gap-2">
				<Button variant="secondary" size="sm" onClick={onClose}>
					Cancel
				</Button>
				<Button size="sm" disabled={!canSave} onClick={save}>
					Save and confirm
				</Button>
			</div>
		</section>
	)
}
