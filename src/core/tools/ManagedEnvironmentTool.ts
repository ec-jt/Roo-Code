import path from "node:path"
import { RooCodeEventName, type ClineSayTool } from "@roo-code/types"
import type { Task } from "../task/Task"
import type { NativeToolArgs } from "../../shared/tools"
import {
	prepareEnvironment,
	installEnvironment,
	inspectEnvironments,
	type ManagedEnvironmentPolicy,
} from "../../services/managed-environments"
import { getManagedEnvironmentPolicy } from "../../services/managed-environments/settings"
import { BaseTool, type ToolCallbacks } from "./BaseTool"

export class ManagedEnvironmentTool extends BaseTool<"managed_environment"> {
	readonly name = "managed_environment" as const

	async execute(params: NativeToolArgs["managed_environment"], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const controller = new AbortController()
		const isClosed = () =>
			task.abort || task.abandoned || task.modelOperationDispatchClosed || task.abortReason === "user_cancelled"
		const abort = () => controller.abort()
		const checkCancellation = () => {
			if (isClosed()) abort()
			if (controller.signal.aborted) throw new Error("Managed environment operation cancelled")
		}
		task.on(RooCodeEventName.TaskAborted, abort)
		const poll = setInterval(() => {
			if (isClosed()) abort()
		}, 100)
		try {
			checkCancellation()
			const { action, manifest_path: manifestPath } = params
			if (
				!["prepare", "install", "status"].includes(action) ||
				Object.keys(params).some((key) => !["action", "manifest_path"].includes(key))
			) {
				throw new Error("Only prepare, install, or status with manifest_path is supported")
			}
			if (typeof manifestPath !== "string" || !manifestPath.trim() || path.isAbsolute(manifestPath)) {
				throw new Error("manifest_path must be a non-empty workspace-relative path")
			}
			const absoluteManifest = path.resolve(task.cwd, manifestPath)
			const relative = path.relative(task.cwd, absoluteManifest)
			if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
				throw new Error("Manifest must be inside the workspace")
			}
			const readPolicy = async () => getManagedEnvironmentPolicy(await task.providerRef.deref()?.getState())
			const policy = await readPolicy()
			const policySnapshot = JSON.stringify(policy)
			const checkAccess = (current: ManagedEnvironmentPolicy) => {
				for (const filename of [absoluteManifest, current.root, current.pythonPath]) {
					if (!task.rooIgnoreController?.validateAccess(filename)) {
						throw new Error(`Managed environment access denied by .rooignore: ${filename}`)
					}
					if (task.rooProtectedController?.isWriteProtected(filename)) {
						throw new Error(`Managed environment access denied for protected path: ${filename}`)
					}
				}
			}
			const recheck = async () => {
				checkCancellation()
				const current = await readPolicy()
				if (JSON.stringify(current) !== policySnapshot) {
					throw new Error("Managed environment settings changed; prepare and approve again")
				}
				checkAccess(current)
				checkCancellation()
			}
			checkAccess(policy)
			const request = (content: string) =>
				callbacks.askApproval(
					"tool",
					JSON.stringify({
						tool: "managedEnvironment",
						action,
						path: manifestPath,
						content,
					} satisfies ClineSayTool),
				)
			const input = { workspaceDir: task.cwd, manifestPath, policy }
			if (action === "install") {
				// Bounded, read-only planning builds the single exact installation approval.
				const plan = await prepareEnvironment(input)
				checkCancellation()
				if (!(await request(JSON.stringify(plan, null, 2)))) return
				await recheck()
				// Retain the original service capability. Never clone or rebuild approved plans.
				const result = await installEnvironment(plan, { taskId: task.taskId, signal: controller.signal })
				checkCancellation()
				callbacks.pushToolResult(JSON.stringify(result))
			} else {
				if (!(await request(JSON.stringify({ action, manifestPath, policy }, null, 2)))) return
				await recheck()
				const result = action === "prepare" ? await prepareEnvironment(input) : await inspectEnvironments(input)
				checkCancellation()
				callbacks.pushToolResult(JSON.stringify(result))
			}
			task.consecutiveMistakeCount = 0
		} catch (error) {
			task.didToolFailInCurrentTurn = true
			await callbacks.handleError(
				"managing Python environment",
				error instanceof Error ? error : new Error(String(error)),
			)
		} finally {
			clearInterval(poll)
			task.off(RooCodeEventName.TaskAborted, abort)
		}
	}
}

export const managedEnvironmentTool = new ManagedEnvironmentTool()
