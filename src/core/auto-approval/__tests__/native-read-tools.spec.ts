import type { ClineSayTool } from "@roo-code/types"
import { checkAutoApproval } from "../index"
import { canAlwaysAllowReadOnly } from "../../../shared/toolApproval"
import { MarkdownifyTool } from "../../tools/MarkdownifyTool"
import type { Task } from "../../task/Task"

const state = { autoApprovalEnabled: true, alwaysAllowReadOnly: true }
const tools: ClineSayTool[] = [
	{ tool: "markdownify", url: "https://openvdn.github.io", isOutsideWorkspace: false },
	{ tool: "markdownify", path: "README.md", isOutsideWorkspace: false },
	{ tool: "fileSystem", action: "read_text_file" },
	{ tool: "fileSystem", action: "list_directory" },
	{ tool: "fileSystem", action: "search_files" },
	{ tool: "gitTools", action: "status" },
	{ tool: "gitTools", action: "working_state" },
	{ tool: "gitTools", action: "search_commits" },
	{ tool: "gitTools", action: "commit_info" },
	{ tool: "gitRepoResearch", action: "search_commits" },
	{ tool: "gitRepoResearch", action: "get_commit_info" },
	{ tool: "gitRepoResearch", action: "get_working_state" },
	{ tool: "braveWebSearch" },
	{ tool: "braveLocalSearch" },
	{ tool: "context7ResolveLibraryId" },
	{ tool: "context7QueryDocs" },
	{ tool: "readCommandOutput" },
]

describe("native read-only approval", () => {
	it.each(tools)("uses Read for $tool $action", async (tool) => {
		const text = JSON.stringify(tool)
		expect(await checkAutoApproval({ state, ask: "tool", text })).toEqual({ decision: "approve" })
		expect(canAlwaysAllowReadOnly({ ts: 1, type: "ask", ask: "tool", text })).toBe(true)
		expect(await checkAutoApproval({ state: { ...state, alwaysAllowReadOnly: false }, ask: "tool", text })).toEqual(
			{ decision: "ask" },
		)
		expect(await checkAutoApproval({ state: { ...state, autoApprovalEnabled: false }, ask: "tool", text })).toEqual(
			{ decision: "ask" },
		)
		expect(await checkAutoApproval({ state, ask: "tool", text, requiresToolApproval: true })).toEqual({
			decision: "ask",
		})
	})

	it.each(["markdownify", "fileSystem", "readFile"] as const)(
		"preserves outside-workspace permission for %s",
		async (tool) => {
			const text = JSON.stringify({
				tool,
				action: "read_text_file",
				path: "../private",
				isOutsideWorkspace: true,
			})
			expect(await checkAutoApproval({ state, ask: "tool", text })).toEqual({ decision: "ask" })
			expect(
				await checkAutoApproval({
					state: { ...state, alwaysAllowReadOnlyOutsideWorkspace: true },
					ask: "tool",
					text,
				}),
			).toEqual({ decision: "approve" })
			expect(canAlwaysAllowReadOnly({ ts: 1, type: "ask", ask: "tool", text })).toBe(false)
		},
	)

	it.each([
		{ tool: "fileSystem", action: "delete_file" },
		{ tool: "gitTools", action: "reset" },
		{ tool: "gitRepoResearch", action: "checkout" },
		{ tool: "newFileCreated" },
		{ tool: "unknown" },
	])("does not grant Read to unsupported or writing actions: $tool $action", async (tool) => {
		expect(await checkAutoApproval({ state, ask: "tool", text: JSON.stringify(tool) })).toEqual({ decision: "ask" })
	})

	it.each([false, true])(
		"approves the real Markdownify URL payload with All actions (mandatory=%s)",
		async (mandatory) => {
			const urlContentFetcher = {
				launchBrowser: vi.fn(),
				urlToMarkdown: vi.fn().mockResolvedValue("# OpenVDN"),
				closeBrowser: vi.fn(),
			}
			const task = { cwd: "/workspace", urlContentFetcher } as unknown as Task
			const askApproval = vi.fn(async (ask, text) => {
				expect(JSON.parse(text)).toMatchObject({
					tool: "markdownify",
					url: "https://openvdn.github.io",
					isOutsideWorkspace: false,
				})
				const result = await checkAutoApproval({
					state: { autoApprovalEnabled: true, alwaysAllowAll: true },
					ask,
					text,
					requiresToolApproval: mandatory,
				})
				expect(result.decision).toBe(mandatory ? "ask" : "approve")
				return result.decision === "approve"
			})
			await new MarkdownifyTool().execute({ url: "https://openvdn.github.io" }, task, {
				askApproval,
				pushToolResult: vi.fn(),
				handleError: vi.fn(),
			})
			expect(askApproval).toHaveBeenCalledOnce()
			expect(urlContentFetcher.urlToMarkdown).toHaveBeenCalledTimes(mandatory ? 0 : 1)
		},
	)
})
