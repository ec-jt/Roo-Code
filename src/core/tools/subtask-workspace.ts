/**
 * Shared or isolated workspace for a subtask (ADR-2026-11-20-isolated-subtask-workspace).
 *
 * "shared" (default) keeps today's behaviour: the child works in the parent's folder.
 * "isolated" runs the child in a new git worktree on `roo/subtask/<childTaskId>`, created
 * from the parent's HEAD. The child's changes return as a branch and a diff stat. Roo never
 * merges the branch and never removes the worktree on its own.
 *
 * The parameter exists only in a development extension host.
 */

import { execFile } from "child_process"
import { existsSync, realpathSync } from "fs"
import * as path from "path"
import { promisify } from "util"

import * as vscode from "vscode"
import type OpenAI from "openai"

import type { HistoryItem } from "@roo-code/types"
import { worktreeService } from "@roo-code/core"

import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { isPathInsideRealRoot } from "../../utils/containedPath"

const execFileAsync = promisify(execFile)

export type SubtaskWorkspaceMode = "shared" | "isolated"

/** Persisted on the child's history item (optional, additive fields). */
export interface IsolatedSubtaskWorkspace {
	mode: "isolated"
	/** Root of the git worktree. */
	worktreePath: string
	/** Branch the worktree is on: roo/subtask/<childTaskId>. */
	branch: string
	/** Commit the worktree was created from (the parent's HEAD). */
	baseCommit: string
}

/** Stable VS Code API value of ExtensionMode.Development, used when the enum is unavailable (test mocks). */
const DEVELOPMENT_MODE = 2

function developmentMode(): number {
	try {
		return vscode.ExtensionMode?.Development ?? DEVELOPMENT_MODE
	} catch {
		return DEVELOPMENT_MODE
	}
}

/** True only when the extension host runs in development mode. */
export function isSubtaskWorkspaceEnabled(provider: unknown): boolean {
	const mode = (provider as { contextProxy?: { extensionMode?: number } } | undefined)?.contextProxy?.extensionMode
	if (mode === undefined) return false
	return mode === developmentMode()
}

export function subtaskBranchName(childTaskId: string): string {
	return `roo/subtask/${childTaskId}`
}

export const SUBTASK_WORKSPACE_GUIDANCE = `Workspace for the subtask (development builds only). Use "shared" (the default; null means shared) when the child continues this task's work and you build on its changes, when it needs this task's uncommitted state, installed dependencies or build output, or when it only reads or investigates. Use "isolated" when the child tries an alternative that may be discarded, when several children try independent approaches to the same change, when this task's working tree must not change, or when the child must not see uncommitted files (for example leak-sensitive evaluation). An isolated child runs in a new git worktree created from HEAD on the branch roo/subtask/<childTaskId>. Uncommitted changes are not copied, and dependencies and build output are not present. Its changes return as a branch name and a diff stat. They are never merged or applied automatically. Isolation fails with an error, and never falls back to shared, when the workspace is not a git repository.`

/**
 * Return a copy of the new_task schema with the optional `workspace` parameter.
 * Call only in a development host. The production schema never contains the parameter.
 */
export function withSubtaskWorkspaceParameter(tool: OpenAI.Chat.ChatCompletionTool): OpenAI.Chat.ChatCompletionTool {
	const fn = (tool as OpenAI.Chat.ChatCompletionFunctionTool).function
	if (!fn || fn.name !== "new_task") return tool
	const parameters = (fn.parameters ?? {}) as {
		properties?: Record<string, unknown>
		required?: string[]
		[key: string]: unknown
	}
	return {
		...tool,
		function: {
			...fn,
			description: `${fn.description ?? ""}\n\nWorkspace choice: ${SUBTASK_WORKSPACE_GUIDANCE}`,
			parameters: {
				...parameters,
				properties: {
					...(parameters.properties ?? {}),
					workspace: {
						type: ["string", "null"],
						enum: ["shared", "isolated", null],
						description: SUBTASK_WORKSPACE_GUIDANCE,
					},
				},
				required: [...(parameters.required ?? []), "workspace"],
			},
		},
	} as OpenAI.Chat.ChatCompletionTool
}

/** Apply the development-only parameter to a native tool list. */
export function applySubtaskWorkspaceSchema(
	tools: OpenAI.Chat.ChatCompletionTool[],
	enabled: boolean,
): OpenAI.Chat.ChatCompletionTool[] {
	if (!enabled) return tools
	return tools.map((tool) =>
		(tool as OpenAI.Chat.ChatCompletionFunctionTool).function?.name === "new_task"
			? withSubtaskWorkspaceParameter(tool)
			: tool,
	)
}

/** Normalise the model's value. Anything other than "isolated" is shared. */
export function parseSubtaskWorkspace(value: unknown): SubtaskWorkspaceMode {
	return value === "isolated" ? "isolated" : "shared"
}

function errorText(error: unknown): string {
	const e = error as { stderr?: string; message?: string }
	return (e?.stderr?.trim() || e?.message || String(error)).split("\n")[0]
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 })
	return stdout
}

function realpath(p: string): string {
	try {
		return realpathSync(p)
	} catch {
		return p
	}
}

export interface IsolatedWorkspacePlan {
	repoRoot: string
	baseCommit: string
	/** Path of the parent cwd relative to the repository root ("" at the root). */
	relativeCwd: string
}

/**
 * Check that the parent cwd can host an isolated subtask. Throws with the reason otherwise.
 * Creates nothing.
 */
export async function planIsolatedWorkspace(parentCwd: string): Promise<IsolatedWorkspacePlan> {
	if (!parentCwd || !existsSync(parentCwd)) {
		throw new Error(`the parent workspace folder does not exist (${parentCwd || "none"})`)
	}
	if (!(await worktreeService.checkGitRepo(parentCwd))) {
		throw new Error(`${parentCwd} is not inside a git repository`)
	}
	const repoRoot = await worktreeService.getGitRootPath(parentCwd)
	if (!repoRoot) throw new Error(`the git repository root of ${parentCwd} could not be found`)
	let baseCommit: string
	try {
		baseCommit = (await git(parentCwd, ["rev-parse", "--verify", "HEAD"])).trim()
	} catch (error) {
		throw new Error(`the repository has no HEAD commit to branch from (${errorText(error)})`)
	}
	const relativeCwd = path.relative(realpath(repoRoot), realpath(parentCwd))
	return { repoRoot, baseCommit, relativeCwd: relativeCwd.startsWith("..") ? "" : relativeCwd }
}

export function isolatedWorktreePath(repoRoot: string, childTaskId: string): string {
	const shortId = childTaskId.replace(/-/g, "").slice(-8)
	return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-subtask-${shortId}`)
}

/**
 * Create the worktree with the existing worktree service. Throws with the reason on failure.
 * Returns the record to persist and the cwd for the child.
 */
export async function createIsolatedWorkspace(
	parentCwd: string,
	childTaskId: string,
	plan?: IsolatedWorkspacePlan,
): Promise<{ workspace: IsolatedSubtaskWorkspace; childCwd: string }> {
	const { repoRoot, baseCommit, relativeCwd } = plan ?? (await planIsolatedWorkspace(parentCwd))
	const worktreePath = isolatedWorktreePath(repoRoot, childTaskId)
	if (existsSync(worktreePath)) throw new Error(`the target folder already exists: ${worktreePath}`)
	const branch = subtaskBranchName(childTaskId)
	const result = await worktreeService.createWorktree(parentCwd, {
		path: worktreePath,
		branch,
		baseBranch: baseCommit,
		createNewBranch: true,
	})
	if (!result.success) throw new Error(result.message)
	const childCwd = relativeCwd ? path.join(worktreePath, relativeCwd) : worktreePath
	return { workspace: { mode: "isolated", worktreePath, branch, baseCommit }, childCwd }
}

/** Text for the parent's new_task tool result after an isolated delegation. */
export function formatIsolatedDelegation(childTaskId: string, workspace: IsolatedSubtaskWorkspace): string {
	return [
		`Delegated to child task ${childTaskId} in an isolated workspace: branch ${workspace.branch} at ${workspace.worktreePath}, created from ${workspace.baseCommit.slice(0, 12)} (this task's HEAD).`,
		"This task's uncommitted changes are not in the worktree, and dependencies and build output are not installed there.",
		"The child's changes will return as a branch and a diff stat. They are not merged or applied to this workspace automatically.",
	].join("\n")
}

/** Optional additive history-item fields for an isolated child (C-5). */
export function subtaskWorkspaceHistoryFields(
	workspace: IsolatedSubtaskWorkspace | undefined,
): Pick<HistoryItem, "workspaceMode" | "worktreePath" | "worktreeBranch" | "worktreeBaseCommit"> {
	if (!workspace) return {}
	return {
		workspaceMode: "isolated",
		worktreePath: workspace.worktreePath,
		worktreeBranch: workspace.branch,
		worktreeBaseCommit: workspace.baseCommit,
	}
}

/** Read the isolated record back from a history item. Missing fields mean shared. */
export function subtaskWorkspaceFromHistory(item: HistoryItem | undefined): IsolatedSubtaskWorkspace | undefined {
	if (item?.workspaceMode !== "isolated" || !item.worktreePath) return undefined
	return {
		mode: "isolated",
		worktreePath: item.worktreePath,
		branch: item.worktreeBranch ?? subtaskBranchName(item.id),
		baseCommit: item.worktreeBaseCommit ?? "",
	}
}

/**
 * Extra folders that count as inside the workspace for a task's file tools.
 * Returns the worktree root only for an isolated subtask. Shared tasks get [] so their
 * workspace boundary stays the open VS Code folders. The parent repository is never included.
 */
export function getTaskWorkspaceRoots(
	task: { subtaskWorkspace?: Pick<IsolatedSubtaskWorkspace, "mode" | "worktreePath"> } | undefined,
): string[] {
	const workspace = task?.subtaskWorkspace
	if (workspace?.mode !== "isolated" || !workspace.worktreePath) return []
	return [workspace.worktreePath]
}

type WorkspaceBoundTask =
	| {
			subtaskWorkspace?: Pick<IsolatedSubtaskWorkspace, "mode" | "worktreePath">
			nonInteractive?: unknown
	  }
	| undefined

/**
 * Workspace boundary of a task's file tools.
 * - Parallel child (non-interactive, isolated): ONLY its worktree is inside. The editor folders,
 *   which include the parent's checkout, are outside. Symbolic links and `..` are resolved.
 * - Every other task: unchanged (`isPathOutsideWorkspace` with getTaskWorkspaceRoots).
 */
export function isPathOutsideTaskWorkspace(task: WorkspaceBoundTask, filePath: string): boolean {
	const workspace = task?.subtaskWorkspace
	if (task?.nonInteractive && workspace?.mode === "isolated" && workspace.worktreePath)
		return !isPathInsideRealRoot(filePath, workspace.worktreePath)
	return isPathOutsideWorkspace(filePath, getTaskWorkspaceRoots(task))
}

/** Missing worktree of an isolated history item, or undefined when it can be resumed. */
export function missingIsolatedWorktree(item: HistoryItem | undefined): string | undefined {
	const workspace = subtaskWorkspaceFromHistory(item)
	if (!workspace) return undefined
	return existsSync(workspace.worktreePath) ? undefined : workspace.worktreePath
}

/**
 * Summary appended to the result the parent receives from an isolated child.
 * Never throws: git failures are reported in the text.
 */
export async function summarizeIsolatedWorkspace(workspace: IsolatedSubtaskWorkspace): Promise<string> {
	const lines = [`Isolated workspace: branch ${workspace.branch} at ${workspace.worktreePath}`]
	if (!existsSync(workspace.worktreePath)) {
		lines.push("The worktree folder no longer exists, so no diff is available.")
	} else {
		const base = workspace.baseCommit || "HEAD"
		try {
			const stat = (await git(workspace.worktreePath, ["diff", "--stat", `${base}...HEAD`])).trimEnd()
			lines.push(`Committed changes (git diff --stat ${base.slice(0, 12)}...HEAD):`)
			lines.push(stat || "(no committed changes)")
		} catch (error) {
			lines.push(`git diff --stat failed: ${errorText(error)}`)
		}
		try {
			const status = (await git(workspace.worktreePath, ["status", "--short"])).trimEnd()
			lines.push("Uncommitted changes in the worktree (git status --short):")
			lines.push(status || "(none)")
		} catch (error) {
			lines.push(`git status --short failed: ${errorText(error)}`)
		}
	}
	lines.push(
		"These changes were not merged or applied to the parent workspace. Review the branch and merge it if wanted. The worktree is not deleted automatically: remove it from the Worktrees view when it is no longer needed.",
	)
	return lines.join("\n")
}
