import * as vscode from "vscode"
import { randomUUID } from "node:crypto"

/** Read-only native documents. Content never crosses the webview bridge or touches disk. */
export class ChatHistoryDocument implements vscode.Disposable {
	private readonly scheme = `roo-chat-history-${randomUUID()}`
	private readonly content = new Map<string, string>()
	private readonly registration: vscode.Disposable
	private readonly closeSubscription: vscode.Disposable
	private nextDocument = 0

	constructor() {
		this.registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme, {
			provideTextDocumentContent: (uri) =>
				this.content.get(uri.toString()) ?? "History preview expired. Open the message again from the chat.",
		})
		this.closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => {
			if (document.uri.scheme === this.scheme) this.content.delete(document.uri.toString())
		})
	}

	public async open(content: string, isCurrent: () => boolean) {
		const uri = vscode.Uri.from({ scheme: this.scheme, path: `/message-${++this.nextDocument}.txt` })
		this.content.set(uri.toString(), content.trim() ? content : "This history entry contains no stored text.")
		// At most four editor requests are retained by this provider (each already limited to 8 MiB).
		while (this.content.size > 4) this.content.delete(this.content.keys().next().value!)
		const document = await vscode.workspace.openTextDocument(uri)
		if (isCurrent()) await vscode.window.showTextDocument(document, { preview: true })
	}

	public dispose() {
		this.content.clear()
		this.registration.dispose()
		this.closeSubscription.dispose()
	}
}
