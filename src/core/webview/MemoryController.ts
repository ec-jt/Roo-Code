import * as vscode from "vscode"
import path from "node:path"
import type { MemoryBrowserRequest, MemoryBrowserState } from "@roo-code/types"
import type { ClineProvider } from "./ClineProvider"
import { MemoryStore, resolveMemoryProject, type MemoryScope } from "../../services/memory"
import { getTaskMemoryStore } from "../../services/memory/taskMemory"

/** User-only UI entry point. Models cannot grant consent through this controller. */
export class MemoryController {
	private fallback?: { cwd: string; promise: Promise<MemoryStore> }
	private watcher?: vscode.FileSystemWatcher
	private refreshTimer?: NodeJS.Timeout
	private scope: MemoryScope = "project"
	private subscribed = false
	private sequence = 0
	private disposed = false
	constructor(private readonly provider: ClineProvider) {}
	async store(): Promise<MemoryStore> {
		if (this.disposed) throw new Error("Memory controller closed")
		if (vscode.workspace.isTrusted !== true) throw new Error("Memory requires a trusted workspace")
		const task = this.provider.getCurrentTask()
		if (task && !task.abort && !task.abandoned && !task.modelOperationDispatchClosed)
			return getTaskMemoryStore(task)
		const cwd = task?.cwd ?? this.provider.cwd
		if (!cwd) throw new Error("Open a project folder to use memory")
		if (this.fallback?.cwd !== cwd)
			this.fallback = {
				cwd,
				promise: resolveMemoryProject(cwd).then(
					(project) => new MemoryStore(this.provider.context.globalStorageUri.fsPath, project),
				),
			}
		return this.fallback.promise
	}
	async enabled(): Promise<boolean> {
		try {
			return (await (await this.store()).getConsent()).enabled
		} catch {
			return false
		}
	}
	private watch() {
		if (this.watcher) return
		this.watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(path.join(this.provider.context.globalStorageUri.fsPath, "memory"), "**/*"),
		)
		const changed = () => {
			if (!this.subscribed) return
			if (this.refreshTimer) clearTimeout(this.refreshTimer)
			this.refreshTimer = setTimeout(() => {
				void this.refresh(this.scope)
			}, 150)
		}
		this.watcher.onDidChange(changed)
		this.watcher.onDidCreate(changed)
		this.watcher.onDidDelete(changed)
	}
	async refresh(scope: MemoryScope = this.scope, query = "", selectedId?: string): Promise<void> {
		if (this.disposed) return
		this.subscribed = true
		this.scope = scope
		const sequence = ++this.sequence
		try {
			this.watch()
			const store = await this.store()
			const consent = await store.getConsent()
			const list = await store.list(scope, query, 200)
			const selected = selectedId ? await store.read(scope, selectedId) : undefined
			if (sequence !== this.sequence || (await this.store()).project.key !== store.project.key) return
			const state: MemoryBrowserState = {
				projectKey: store.project.key,
				projectLabel: store.project.label,
				rootPath: store.project.rootPath,
				directory: store.getDirectory(scope),
				scope,
				enabled: consent.enabled,
				personalRecall: consent.personalRecall,
				consentRevision: consent.revision,
				listRevision: list.revision,
				records: list.records.map(({ body: _body, ...record }) => record),
				selected,
				errors: list.errors.slice(0, 20).map((issue) => `${issue.file}: ${issue.message}`),
				omitted: list.omitted,
			}
			await this.provider.postMessageToWebview({ type: "memoryBrowser", memoryBrowser: state })
		} catch (error) {
			if (sequence === this.sequence)
				await this.provider.postMessageToWebview({
					type: "memoryBrowser",
					memoryError: error instanceof Error ? error.message : "Memory unavailable",
				})
		}
	}
	async handle(request?: MemoryBrowserRequest): Promise<void> {
		if (!request || !["project", "personal"].includes(request.scope)) return
		try {
			if (request.action === "refresh") return await this.refresh(request.scope, request.query)
			const store = await this.store()
			const assertCurrent = async () => {
				if (
					vscode.workspace.isTrusted !== true ||
					(await this.store()).project.key !== request.projectKey ||
					store.project.key !== request.projectKey
				)
					throw new Error("Memory project changed. Refresh before continuing.")
			}
			await assertCurrent()
			const consent = await store.getConsent()
			if (request.action === "consent") {
				if (request.consentRevision !== consent.revision)
					throw new Error("Memory settings changed. Refresh first.")
				const enabled = request.enabled === true
				const personalRecall = request.personalRecall === true
				if ((enabled && !consent.enabled) || (personalRecall && !consent.personalRecall)) {
					const answer = await vscode.window.showWarningMessage(
						"Enable memory for this project?",
						{
							modal: true,
							detail: `Project: ${store.project.label}\nFolder: ${store.project.rootPath}\nStore: ${store.getDirectory("project")}\n\nProject memory can be read and updated automatically across linked worktrees. Recalled text is sent to the selected model provider. Personal recall: ${personalRecall}. Memory grants no other tool permissions. Disabling retains files and cannot erase existing transcripts or provider inputs.`,
						},
						"Enable memory",
					)
					if (answer !== "Enable memory") return
				}
				await assertCurrent()
				await store.setConsent({ enabled, personalRecall }, consent.revision)
			} else if (request.action === "save") {
				if (!request.input) throw new Error("Missing memory content")
				const input = { ...request.input, ...(request.id ? { id: request.id } : {}) }
				if (request.scope === "personal") {
					const answer = await vscode.window.showWarningMessage(
						"Save personal memory across projects?",
						{ modal: true, detail: JSON.stringify(input, null, 2) },
						"Save personal memory",
					)
					if (answer !== "Save personal memory") throw new Error("Personal memory save cancelled")
				}
				await assertCurrent()
				if ((await store.getConsent()).revision !== request.consentRevision)
					throw new Error("Memory settings changed. Review and save again.")
				const record = await store.upsert(request.scope, input, {
					expectedRevision: request.expectedRevision ?? null,
					authorize: assertCurrent,
				})
				return await this.refresh(request.scope, "", record.id)
			} else if (request.action === "delete" || request.action === "clear") {
				if (typeof request.expectedRevision !== "string") throw new Error("Refresh memory revision first")
				const answer = await vscode.window.showWarningMessage(
					`Forget ${request.action === "clear" ? "all " : ""}${request.scope} memory?`,
					{
						modal: true,
						detail: "This removes future recall, not existing transcripts, snapshots, backups, or provider-held data. Start a new task for a clean context.",
					},
					"Forget",
				)
				if (answer !== "Forget") return
				const options = { expectedRevision: request.expectedRevision, authorize: assertCurrent }
				if (request.action === "clear") await store.clear(request.scope, options)
				else if (request.id) await store.delete(request.scope, request.id, options)
			} else if (request.action === "read" && request.id) {
				return await this.refresh(request.scope, "", request.id)
			} else if (request.action === "open" && request.id) {
				if (!(await store.read(request.scope, request.id))) throw new Error("Memory was forgotten")
				await assertCurrent()
				await vscode.window.showTextDocument(
					await vscode.workspace.openTextDocument(
						vscode.Uri.file(store.getRecordPath(request.scope, request.id)),
					),
				)
			} else throw new Error("Unsupported memory operation")
			await this.refresh(request.scope)
		} catch (error) {
			await this.provider.postMessageToWebview({
				type: "memoryBrowser",
				memoryError: error instanceof Error ? error.message : "Memory operation failed",
			})
		}
	}
	dispose() {
		this.disposed = true
		this.sequence++
		if (this.refreshTimer) clearTimeout(this.refreshTimer)
		this.watcher?.dispose()
	}
}
