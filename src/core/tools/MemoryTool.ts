import * as vscode from "vscode"
import type { ClineSayTool } from "@roo-code/types"
import type { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { isToolAllowedForMode } from "./validateToolUse"
import { memoryArgsSchema } from "../prompts/tools/native-tools/memory"
import { getTaskMemoryStore, assertMemoryAccess, assertMemoryTaskOpen } from "../../services/memory/taskMemory"
import { validateInput } from "../../services/memory/records"
import { MemoryError, type MemoryRecord, type MemoryList } from "../../services/memory/types"

const metadata = ({ body, ...record }: MemoryRecord) => record

export function boundedMemoryList(list: MemoryList): string {
	const records = list.records.map(metadata)
	const result = () =>
		JSON.stringify({
			records,
			revision: list.revision,
			total: list.total,
			omitted: list.total - records.length,
			truncated: records.length < list.total,
			errors: list.errors.length,
		})
	while (Buffer.byteLength(result()) > 16 * 1024 && records.length) records.pop()
	return result()
}

export function boundedMemoryRead(record: MemoryRecord): string {
	let body = record.body
	const result = () => JSON.stringify({ ...metadata(record), body, truncated: body !== record.body })
	// JSON escaping can expand text beyond the file's byte limit. Keep valid JSON and Unicode.
	while (Buffer.byteLength(result()) > 32 * 1024 && body.length) {
		body = body.slice(
			0,
			Math.max(0, body.length - Math.max(1, Math.ceil((Buffer.byteLength(result()) - 32 * 1024) / 2))),
		)
		if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1)
	}
	return result()
}

export class MemoryTool extends BaseTool<"memory"> {
	readonly name = "memory" as const

	async execute(raw: NativeToolArgs["memory"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		try {
			const params = memoryArgsSchema.parse(raw)
			const { action, scope } = params
			assertMemoryTaskOpen(task)
			const checkMode = async () => {
				assertMemoryTaskOpen(task)
				const state = await task.providerRef.deref()?.getState()
				if (
					!state ||
					state.disabledTools?.includes("memory") ||
					!isToolAllowedForMode("memory", state.mode ?? "code", state.customModes ?? [])
				) {
					throw new MemoryError("MODE", "Memory is not allowed in the current mode")
				}
				assertMemoryTaskOpen(task)
			}
			await checkMode()
			const store = await getTaskMemoryStore(task)
			assertMemoryAccess(task, store, scope, params.id ?? undefined)
			const consent = await store.getConsent()
			const read = action === "read" || action === "list"
			const recheck = async () => {
				await checkMode()
				assertMemoryAccess(task, store, scope, params.id ?? undefined)
				const current = await store.getConsent()
				assertMemoryTaskOpen(task)
				if (
					!current.enabled ||
					current.revision !== consent.revision ||
					(read && scope === "personal" && !current.personalRecall)
				) {
					throw new MemoryError("DISABLED", "Memory consent is disabled or changed; start a new operation")
				}
			}
			await recheck()
			const input =
				action === "upsert"
					? {
							id: params.id ?? undefined,
							name: params.name!,
							description: params.description!,
							type: params.type!,
							body: params.body!,
							sourceTaskId: task.taskId,
						}
					: undefined
			if (input) validateInput(input)
			// Retain the exact record and revision across approval, including the body being forgotten.
			const existing = params.id ? await store.read(scope, params.id) : undefined
			await recheck()
			if (params.id && !existing) throw new MemoryError("NOT_FOUND", "Memory topic was not found")
			if (!read && params.id && existing?.revision !== params.expected_revision)
				throw new MemoryError("CONFLICT", "Memory changed; reread before approval")
			const content = JSON.stringify(
				{
					scope,
					action,
					id: params.id ?? null,
					expected_revision: params.expected_revision,
					...(input ? { proposed: input } : {}),
					...(existing && !read ? { existing } : {}),
					...(params.query ? { query: params.query } : {}),
				},
				null,
				2,
			)
			if (
				!(await callbacks.askApproval(
					"tool",
					JSON.stringify({ tool: "memory", action, path: scope, content } satisfies ClineSayTool),
				))
			)
				return
			await recheck()
			if (!read && scope === "personal") {
				const confirmation = action === "delete" ? "Forget personal memory" : "Save personal memory"
				const response = await vscode.window.showWarningMessage(
					`${confirmation}? This changes memory shared across projects.`,
					{ modal: true, detail: content },
					confirmation,
				)
				if (response !== confirmation) {
					callbacks.pushToolResult("Personal memory change cancelled.")
					return
				}
				await recheck()
			}
			if (action === "list") {
				const result = await store.list(scope, params.query ?? undefined)
				await recheck()
				callbacks.pushToolResult(boundedMemoryList(result))
			} else if (action === "read") {
				const record = await store.read(scope, params.id!)
				await recheck()
				if (!record) throw new MemoryError("NOT_FOUND", "Memory topic was forgotten")
				callbacks.pushToolResult(boundedMemoryRead(record))
			} else {
				if (action === "upsert") {
					const record = await store.upsert(scope, input!, {
						expectedRevision: params.expected_revision,
						authorize: recheck,
					})
					callbacks.pushToolResult(JSON.stringify({ saved: metadata(record), scope }))
				} else {
					await store.delete(scope, params.id!, {
						expectedRevision: params.expected_revision!,
						authorize: recheck,
					})
					callbacks.pushToolResult(JSON.stringify({ forgotten: params.id, scope }))
				}
				await task.providerRef.deref()?.refreshMemoryBrowser?.(scope)
			}
			task.consecutiveMistakeCount = 0
		} catch (error) {
			task.didToolFailInCurrentTurn = true
			await callbacks.handleError("using memory", error instanceof Error ? error : new Error(String(error)))
		}
	}
}

export const memoryTool = new MemoryTool()
