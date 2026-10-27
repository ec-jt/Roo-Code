export function TaskStateToolApproval({ content }: { content?: string }) {
	let display = content ?? "No request payload available."
	try {
		display = JSON.stringify(JSON.parse(display), null, 2)
	} catch {
		/* Display malformed or partial payload as text. */
	}
	return (
		<section aria-label="Task-state tool request" className="space-y-2">
			<h3 className="font-semibold">Roo requests task-state access</h3>
			<p>
				Review the exact action, expected ledger revision, and changes below. Use the existing chat approval
				controls to allow or deny this request. This does not enable continuation or change tool permissions.
			</p>
			<p>Model work statuses are CLAIMED. Evidence receipts are not verification.</p>
			<pre className="whitespace-pre-wrap break-words max-h-80 overflow-y-auto border border-vscode-panel-border p-2">
				{display}
			</pre>
		</section>
	)
}
