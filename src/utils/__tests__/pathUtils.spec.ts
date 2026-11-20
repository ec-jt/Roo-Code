// npx vitest run utils/__tests__/pathUtils.spec.ts

import * as path from "path"

import * as vscode from "vscode"

import { isPathOutsideWorkspace } from "../pathUtils"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: undefined as unknown,
	},
}))

const root = path.resolve("/a/repo")
const worktree = path.resolve("/a/repo-subtask-1")

function setWorkspaceFolders(folders: string[] | undefined) {
	;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = folders?.map((fsPath) => ({
		uri: { fsPath },
	}))
}

describe("isPathOutsideWorkspace", () => {
	beforeEach(() => setWorkspaceFolders([root]))

	describe("without extra roots (unchanged behaviour)", () => {
		it("treats files in a workspace folder as inside", () => {
			expect(isPathOutsideWorkspace(path.join(root, "src/x.ts"))).toBe(false)
			expect(isPathOutsideWorkspace(root)).toBe(false)
		})

		it("treats files outside every workspace folder as outside", () => {
			expect(isPathOutsideWorkspace(path.join(worktree, "x.ts"))).toBe(true)
			expect(isPathOutsideWorkspace(path.resolve("/a/repo-other/x.ts"))).toBe(true)
		})

		it("treats everything as outside when no folder is open", () => {
			setWorkspaceFolders(undefined)
			expect(isPathOutsideWorkspace(path.join(root, "x.ts"))).toBe(true)
			setWorkspaceFolders([])
			expect(isPathOutsideWorkspace(path.join(root, "x.ts"))).toBe(true)
		})

		it("treats an empty extra-roots list like no extra roots", () => {
			expect(isPathOutsideWorkspace(path.join(worktree, "x.ts"), [])).toBe(true)
		})
	})

	describe("with extra roots", () => {
		it("treats a file inside an extra root as inside", () => {
			expect(isPathOutsideWorkspace(path.join(worktree, "src/x.ts"), [worktree])).toBe(false)
			expect(isPathOutsideWorkspace(worktree, [worktree])).toBe(false)
		})

		it("treats a file inside an extra root as inside when no folder is open", () => {
			setWorkspaceFolders(undefined)
			expect(isPathOutsideWorkspace(path.join(worktree, "x.ts"), [worktree])).toBe(false)
			expect(isPathOutsideWorkspace(path.join(root, "x.ts"), [worktree])).toBe(true)
		})

		it("keeps a sibling folder that shares the name prefix outside", () => {
			expect(isPathOutsideWorkspace(path.resolve("/a/repo-subtask-10/x"), [worktree])).toBe(true)
		})

		it("treats .. traversal out of the extra root as outside", () => {
			expect(isPathOutsideWorkspace(path.join(worktree, "..", "secret", "x"), [worktree])).toBe(true)
			expect(
				isPathOutsideWorkspace(`${worktree}${path.sep}..${path.sep}repo-subtask-10${path.sep}x`, [worktree]),
			).toBe(true)
		})

		it("resolves an unnormalised extra root", () => {
			const messy = `${worktree}${path.sep}sub${path.sep}..`
			expect(isPathOutsideWorkspace(path.join(worktree, "x.ts"), [messy])).toBe(false)
		})

		it("still accepts the open workspace folders", () => {
			expect(isPathOutsideWorkspace(path.join(root, "x.ts"), [worktree])).toBe(false)
		})
	})
})
