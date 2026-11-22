// npx vitest run core/task/parallel/__tests__/confinement.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import {
	OUTSIDE_WORKTREE_REFUSAL,
	PARALLEL_CHILD_CONFINED_TOOLS,
	checkParallelChildConfinement,
	parallelChildToolPolicy,
} from "../non-interactive"
import { isPathInsideRealRoot, resolveRealPath } from "../../../../utils/containedPath"
import { isPathOutsideTaskWorkspace } from "../../../tools/subtask-workspace"

const folders = vi.hoisted(() => ({ editor: "" }))

vi.mock("vscode", () => ({
	workspace: {
		get workspaceFolders() {
			return [{ uri: { fsPath: folders.editor } }]
		},
	},
}))

let root: string
let repo: string
let worktree: string
let confinement: { worktreePath: string; cwd: string }

beforeEach(() => {
	root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "roo-confine-"))
	repo = path.join(root, "repo")
	worktree = path.join(root, "repo-subtask-1234")
	fs.mkdirSync(path.join(repo, "src"), { recursive: true })
	fs.mkdirSync(path.join(worktree, "src"), { recursive: true })
	confinement = { worktreePath: worktree, cwd: worktree }
	folders.editor = repo
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("resolveRealPath / isPathInsideRealRoot", () => {
	it("normalises .. and keeps a missing tail", () => {
		expect(resolveRealPath(path.join(worktree, "src", "..", "..", "repo", "new", "f.txt"))).toBe(
			path.join(repo, "new", "f.txt"),
		)
		expect(isPathInsideRealRoot(path.join(worktree, "a", "b.txt"), worktree)).toBe(true)
		expect(isPathInsideRealRoot(worktree, worktree)).toBe(true)
		expect(isPathInsideRealRoot(path.join(worktree, "..", "repo", "x.txt"), worktree)).toBe(false)
		// A sibling whose name starts with the worktree name is outside.
		expect(isPathInsideRealRoot(`${worktree}-other/x.txt`, worktree)).toBe(false)
	})

	it("follows symbolic links, including dangling ones", () => {
		fs.symlinkSync(repo, path.join(worktree, "dir-link"))
		fs.symlinkSync(path.join(repo, "missing.txt"), path.join(worktree, "file-link"))
		expect(isPathInsideRealRoot(path.join(worktree, "dir-link", "x.txt"), worktree)).toBe(false)
		expect(isPathInsideRealRoot(path.join(worktree, "file-link"), worktree)).toBe(false)
		fs.symlinkSync(path.join(worktree, "src"), path.join(worktree, "inner-link"))
		expect(isPathInsideRealRoot(path.join(worktree, "inner-link", "x.txt"), worktree)).toBe(true)
	})
})

describe("checkParallelChildConfinement", () => {
	it("covers every write-capable tool and commands", () => {
		expect([...PARALLEL_CHILD_CONFINED_TOOLS].sort()).toEqual(
			[
				"apply_diff",
				"apply_patch",
				"edit",
				"edit_file",
				"execute_command",
				"generate_image",
				"generate_video",
				"search_and_replace",
				"search_replace",
				"write_to_file",
			].sort(),
		)
	})

	it.each([
		["write_to_file", { path: "../repo/x.txt", content: "x" }],
		["apply_diff", { path: "../repo/x.txt", diff: "d" }],
		["edit", { file_path: "../repo/x.txt", old_string: "a", new_string: "b" }],
		["search_and_replace", { file_path: "../repo/x.txt", old_string: "a", new_string: "b" }],
		["search_replace", { file_path: "../repo/x.txt", old_string: "a", new_string: "b" }],
		["edit_file", { file_path: "../repo/x.txt", old_string: "a", new_string: "b" }],
		["generate_image", { prompt: "p", path: "../repo/x.png" }],
		["generate_video", { prompt: "p", path: "../repo/x.mp4" }],
	])("refuses %s outside the worktree and allows it inside", (tool, args) => {
		const violation = checkParallelChildConfinement(tool, args, confinement)
		expect(violation?.message).toContain(
			`Parallel subtasks may only change files inside their worktree ${worktree}.`,
		)
		const inside = Object.fromEntries(
			Object.entries(args).map(([k, v]) => [k, typeof v === "string" ? v.replace("../repo/", "src/") : v]),
		)
		expect(checkParallelChildConfinement(tool, inside, confinement)).toBeUndefined()
	})

	it("refuses an absolute path into the parent repository", () => {
		const target = path.join(repo, "src", "x.txt")
		expect(checkParallelChildConfinement("write_to_file", { path: target }, confinement)?.target).toBe(target)
		expect(
			checkParallelChildConfinement("write_to_file", { path: path.join(worktree, "src", "x.txt") }, confinement),
		).toBeUndefined()
	})

	it("checks every apply_patch target, including move destinations and deletions", () => {
		const patch = (lines: string[]) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
		expect(
			checkParallelChildConfinement(
				"apply_patch",
				{ patch: patch(["*** Update File: src/a.ts", "*** Move to: ../repo/src/a.ts", "@@", "-a", "+b"]) },
				confinement,
			)?.target,
		).toBe("../repo/src/a.ts")
		expect(
			checkParallelChildConfinement(
				"apply_patch",
				{ patch: patch([`*** Delete File: ${repo}/README.md`]) },
				confinement,
			)?.target,
		).toBe(`${repo}/README.md`)
		expect(
			checkParallelChildConfinement(
				"apply_patch",
				{ patch: patch(["*** Add File: src/new.ts", "+x", "*** Update File: src/b.ts", "@@", "-a", "+b"]) },
				confinement,
			),
		).toBeUndefined()
	})

	it("refuses a command cwd outside the worktree; a missing cwd is allowed", () => {
		expect(
			checkParallelChildConfinement("execute_command", { command: "ls", cwd: repo }, confinement)?.message,
		).toBe(
			`Parallel subtasks may only run commands inside their worktree ${worktree}. The working directory ${repo} is outside it.`,
		)
		expect(
			checkParallelChildConfinement("execute_command", { command: "ls", cwd: "src" }, confinement),
		).toBeUndefined()
		expect(checkParallelChildConfinement("execute_command", { command: "ls" }, confinement)).toBeUndefined()
	})

	it("ignores read tools and calls without a target", () => {
		expect(checkParallelChildConfinement("read_file", { path: "../repo/x.txt" }, confinement)).toBeUndefined()
		expect(checkParallelChildConfinement("write_to_file", {}, confinement)).toBeUndefined()
		expect(checkParallelChildConfinement("write_to_file", undefined, confinement)).toBeUndefined()
	})
})

describe("parallelChildToolPolicy", () => {
	const invoke = (policy: ReturnType<typeof parallelChildToolPolicy>, name: string, args: unknown) =>
		policy.evaluate({ taskId: "t", instanceId: "i", toolCallId: "c", identity: { kind: "builtin", name }, args })

	it("refuses and records an outside-worktree change; never turns anything into an approval", () => {
		const refused: unknown[] = []
		const policy = parallelChildToolPolicy((r) => refused.push(r), confinement)
		expect(invoke(policy, "write_to_file", { path: "../repo/x.txt" })).toMatchObject({ allow: false })
		expect(refused).toEqual([{ type: OUTSIDE_WORKTREE_REFUSAL, tool: "write_to_file", detail: "../repo/x.txt" }])
		expect(invoke(policy, "write_to_file", { path: "src/x.txt" })).toEqual({ allow: true })
	})

	it("without a confinement, keeps the previous behaviour", () => {
		const policy = parallelChildToolPolicy(() => {})
		expect(invoke(policy, "write_to_file", { path: "../repo/x.txt" })).toEqual({ allow: true })
		expect(invoke(policy, "new_task", {})).toMatchObject({ allow: false })
	})
})

describe("isPathOutsideTaskWorkspace", () => {
	const isolated = { mode: "isolated" as const, worktreePath: "" }

	it("treats only the worktree as inside for a parallel child", () => {
		const child = { nonInteractive: {}, subtaskWorkspace: { ...isolated, worktreePath: worktree } }
		expect(isPathOutsideTaskWorkspace(child, path.join(worktree, "src", "a.ts"))).toBe(false)
		// The editor folder (the parent's checkout) is outside for the child.
		expect(isPathOutsideTaskWorkspace(child, path.join(repo, "src", "a.ts"))).toBe(true)
		expect(isPathOutsideTaskWorkspace(child, path.join(worktree, "..", "repo", "x.txt"))).toBe(true)
	})

	it("keeps the editor folders plus the worktree for a sequential isolated subtask", () => {
		const sequential = { subtaskWorkspace: { ...isolated, worktreePath: worktree } }
		expect(isPathOutsideTaskWorkspace(sequential, path.join(worktree, "a.ts"))).toBe(false)
		expect(isPathOutsideTaskWorkspace(sequential, path.join(repo, "a.ts"))).toBe(false)
		expect(isPathOutsideTaskWorkspace(sequential, path.join(root, "elsewhere", "a.ts"))).toBe(true)
	})

	it("keeps the editor folders for a shared task", () => {
		expect(isPathOutsideTaskWorkspace({}, path.join(repo, "a.ts"))).toBe(false)
		expect(isPathOutsideTaskWorkspace(undefined, path.join(worktree, "a.ts"))).toBe(true)
	})
})
