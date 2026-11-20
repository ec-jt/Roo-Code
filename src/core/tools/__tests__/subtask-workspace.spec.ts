// npx vitest run core/tools/__tests__/subtask-workspace.spec.ts

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import type OpenAI from "openai"

import { getNativeTools } from "../../prompts/tools/native-tools"
import { RepoPerTaskCheckpointService } from "../../../services/checkpoints/RepoPerTaskCheckpointService"
import {
	applySubtaskWorkspaceSchema,
	createIsolatedWorkspace,
	getTaskWorkspaceRoots,
	isSubtaskWorkspaceEnabled,
	isolatedWorktreePath,
	missingIsolatedWorktree,
	parseSubtaskWorkspace,
	planIsolatedWorkspace,
	subtaskWorkspaceFromHistory,
	subtaskWorkspaceHistoryFields,
	summarizeIsolatedWorkspace,
} from "../subtask-workspace"

// ExtensionMode values in the VS Code API: Production = 1, Development = 2, Test = 3.
const dev = { contextProxy: { extensionMode: 2 } }
const prod = { contextProxy: { extensionMode: 1 } }

const newTaskSchema = (tools: OpenAI.Chat.ChatCompletionTool[]) =>
	(tools.find((t) => (t as OpenAI.Chat.ChatCompletionFunctionTool).function?.name === "new_task") as
		| OpenAI.Chat.ChatCompletionFunctionTool
		| undefined)!.function

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

describe("getTaskWorkspaceRoots", () => {
	it("returns no extra roots for a shared task", () => {
		expect(getTaskWorkspaceRoots(undefined)).toEqual([])
		expect(getTaskWorkspaceRoots({})).toEqual([])
		expect(getTaskWorkspaceRoots({ subtaskWorkspace: undefined })).toEqual([])
	})

	it("returns only the worktree root for an isolated task", () => {
		const worktreePath = "/repos/project-subtask-1234abcd"
		expect(
			getTaskWorkspaceRoots({
				subtaskWorkspace: { mode: "isolated", worktreePath, branch: "roo/subtask/x", baseCommit: "abc" },
			} as Parameters<typeof getTaskWorkspaceRoots>[0]),
		).toEqual([worktreePath])
	})

	it("returns no extra roots when the worktree path is missing", () => {
		expect(getTaskWorkspaceRoots({ subtaskWorkspace: { mode: "isolated", worktreePath: "" } })).toEqual([])
	})
})

describe("subtask workspace schema", () => {
	it("is enabled only in a development extension host", () => {
		expect(isSubtaskWorkspaceEnabled(dev)).toBe(true)
		expect(isSubtaskWorkspaceEnabled(prod)).toBe(false)
		expect(isSubtaskWorkspaceEnabled({ contextProxy: { extensionMode: 3 } })).toBe(false)
		expect(isSubtaskWorkspaceEnabled({})).toBe(false)
		expect(isSubtaskWorkspaceEnabled(undefined)).toBe(false)
	})

	it("adds the workspace parameter in development mode", () => {
		const fn = newTaskSchema(applySubtaskWorkspaceSchema(getNativeTools(), isSubtaskWorkspaceEnabled(dev)))
		const params = fn.parameters as { properties: Record<string, any>; required: string[] }
		expect(params.properties.workspace.enum).toEqual(["shared", "isolated", null])
		expect(params.required).toContain("workspace")
		expect(fn.description).toContain('Use "isolated" when')
	})

	it("leaves the parameter absent in production", () => {
		const tools = applySubtaskWorkspaceSchema(getNativeTools(), isSubtaskWorkspaceEnabled(prod))
		const fn = newTaskSchema(tools)
		const params = fn.parameters as { properties: Record<string, unknown>; required: string[] }
		expect(params.properties).not.toHaveProperty("workspace")
		expect(params.required).not.toContain("workspace")
		expect(JSON.stringify(fn)).not.toContain("isolated")
		// The base schema is never mutated by the development variant.
		applySubtaskWorkspaceSchema(getNativeTools(), true)
		expect(JSON.stringify(newTaskSchema(getNativeTools()))).not.toContain('workspace":')
	})

	it("treats anything except isolated as shared", () => {
		expect(parseSubtaskWorkspace("isolated")).toBe("isolated")
		expect(parseSubtaskWorkspace("shared")).toBe("shared")
		expect(parseSubtaskWorkspace(null)).toBe("shared")
		expect(parseSubtaskWorkspace(undefined)).toBe("shared")
		expect(parseSubtaskWorkspace("ISOLATED")).toBe("shared")
	})
})

describe("isolated subtask workspace (real git)", () => {
	let tmp: string
	let repo: string

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "roo-subtask-"))
		repo = path.join(tmp, "project")
		fs.mkdirSync(repo)
		git(repo, "init", "-q")
		git(repo, "config", "user.email", "test@example.com")
		git(repo, "config", "user.name", "Test")
		git(repo, "config", "commit.gpgsign", "false")
		fs.writeFileSync(path.join(repo, "a.txt"), "base\n")
		git(repo, "add", ".")
		git(repo, "commit", "-q", "-m", "base")
	})

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true })
	})

	it("creates a worktree from HEAD on roo/subtask/<id> and keeps the parent tree unchanged", async () => {
		// Uncommitted parent work must not be copied.
		fs.writeFileSync(path.join(repo, "parent-dirty.txt"), "uncommitted\n")
		const parentStatusBefore = git(repo, "status", "--short")
		const head = git(repo, "rev-parse", "HEAD").trim()

		const childId = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001"
		const { workspace, childCwd } = await createIsolatedWorkspace(repo, childId)

		expect(workspace.worktreePath).toBe(path.join(tmp, "project-subtask-ffff0001"))
		expect(workspace.worktreePath).toBe(isolatedWorktreePath(repo, childId))
		expect(childCwd).toBe(workspace.worktreePath)
		expect(workspace.branch).toBe(`roo/subtask/${childId}`)
		expect(workspace.baseCommit).toBe(head)
		expect(git(childCwd, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(workspace.branch)
		expect(fs.existsSync(path.join(childCwd, "parent-dirty.txt"))).toBe(false)

		// The child writes and commits in its worktree only.
		fs.writeFileSync(path.join(childCwd, "child.txt"), "child work\n")
		git(childCwd, "add", "child.txt")
		git(childCwd, "commit", "-q", "-m", "child")
		fs.writeFileSync(path.join(childCwd, "a.txt"), "changed but not committed\n")

		expect(git(repo, "status", "--short")).toBe(parentStatusBefore)
		expect(fs.existsSync(path.join(repo, "child.txt"))).toBe(false)
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("base\n")

		const summary = await summarizeIsolatedWorkspace(workspace)
		expect(summary).toContain(`Isolated workspace: branch roo/subtask/${childId} at ${workspace.worktreePath}`)
		expect(summary).toContain("child.txt")
		expect(summary).toMatch(/1 file changed, 1 insertion/)
		expect(summary).toContain(" M a.txt")
		expect(summary).toContain("not merged")
		expect(summary).toContain("not deleted automatically")
	})

	it("starts the child in the same subfolder when the parent cwd is below the repository root", async () => {
		const sub = path.join(repo, "pkg")
		fs.mkdirSync(sub)
		fs.writeFileSync(path.join(sub, "b.txt"), "b\n")
		git(repo, "add", ".")
		git(repo, "commit", "-q", "-m", "pkg")
		const { workspace, childCwd } = await createIsolatedWorkspace(sub, "child-sub-0002")
		expect(childCwd).toBe(path.join(workspace.worktreePath, "pkg"))
		expect(fs.existsSync(path.join(childCwd, "b.txt"))).toBe(true)
	})

	it("fails with the reason outside a git repository and creates nothing", async () => {
		const plain = path.join(tmp, "plain")
		fs.mkdirSync(plain)
		await expect(planIsolatedWorkspace(plain)).rejects.toThrow(/not inside a git repository/)
		await expect(createIsolatedWorkspace(plain, "child-0003")).rejects.toThrow(/not inside a git repository/)
		expect(fs.readdirSync(tmp).sort()).toEqual(["plain", "project"])
	})

	it("fails when the target folder already exists", async () => {
		const childId = "child-0004"
		fs.mkdirSync(isolatedWorktreePath(repo, childId))
		await expect(createIsolatedWorkspace(repo, childId)).rejects.toThrow(/already exists/)
	})

	it("persists additive history fields and reports a missing worktree on resume", async () => {
		const childId = "child-0005"
		const { workspace } = await createIsolatedWorkspace(repo, childId)
		const item = {
			id: childId,
			number: 1,
			ts: 1,
			task: "t",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			...subtaskWorkspaceHistoryFields(workspace),
		}
		expect(item.workspaceMode).toBe("isolated")
		expect(subtaskWorkspaceFromHistory(item)).toEqual(workspace)
		expect(missingIsolatedWorktree(item)).toBeUndefined()

		git(repo, "worktree", "remove", "--force", workspace.worktreePath)
		expect(missingIsolatedWorktree(item)).toBe(workspace.worktreePath)

		// Old items without the fields stay shared and are never treated as missing (C-5).
		const legacy = { id: "old", number: 1, ts: 1, task: "t", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		expect(subtaskWorkspaceHistoryFields(undefined)).toEqual({})
		expect(subtaskWorkspaceFromHistory(legacy)).toBeUndefined()
		expect(missingIsolatedWorktree(legacy)).toBeUndefined()
	})

	it("stores child checkpoints apart from the parent's", async () => {
		const { childCwd } = await createIsolatedWorkspace(repo, "child-0006")
		const storage = path.join(tmp, "storage")
		// The workspace hash used for workspace-keyed storage differs for the worktree cwd.
		expect(RepoPerTaskCheckpointService.hashWorkspaceDir(childCwd)).not.toBe(
			RepoPerTaskCheckpointService.hashWorkspaceDir(repo),
		)
		// The per-task shadow repository is in the child's own task folder, and its work tree is the worktree.
		const parentService = RepoPerTaskCheckpointService.create({
			taskId: "parent",
			workspaceDir: repo,
			shadowDir: storage,
			log: () => {},
		})
		const childService = RepoPerTaskCheckpointService.create({
			taskId: "child-0006",
			workspaceDir: childCwd,
			shadowDir: storage,
			log: () => {},
		})
		expect(childService.checkpointsDir).not.toBe(parentService.checkpointsDir)
		expect(childService.workspaceDir).toBe(childCwd)
	})
})
