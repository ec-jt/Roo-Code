/**
 * Tests for the shared delegation-tool isolation helpers used by Task.ts.
 *
 * `new_task` and `new_tasks` must both be the last tool call in an assistant turn.
 * Tool calls after the first delegation tool are truncated and receive an error tool_result.
 */

import type { Anthropic } from "@anthropic-ai/sdk"

import {
	DELEGATION_TOOL_NAMES,
	delegationTruncationMessage,
	findDelegationToolIndex,
	isDelegationTool,
} from "../delegation-tools"

type Block = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam

/** Mirrors the truncation in Task.ts, using the shared helpers. */
const enforceDelegationIsolation = (assistantContent: Block[]) => {
	const injectedToolResults: Anthropic.ToolResultBlockParam[] = []
	const index = findDelegationToolIndex(assistantContent)
	if (index === -1 || index >= assistantContent.length - 1) {
		return { truncatedContent: assistantContent, injectedToolResults }
	}
	const name = (assistantContent[index] as Anthropic.ToolUseBlockParam).name
	for (const tool of assistantContent.slice(index + 1)) {
		if (tool.type === "tool_use" && tool.id) {
			injectedToolResults.push({
				type: "tool_result",
				tool_use_id: tool.id,
				content: delegationTruncationMessage(name),
				is_error: true,
			})
		}
	}
	return { truncatedContent: assistantContent.slice(0, index + 1), injectedToolResults }
}

const tool = (id: string, name: string): Anthropic.ToolUseBlockParam => ({ type: "tool_use", id, name, input: {} })

describe("delegation tools", () => {
	describe("isDelegationTool", () => {
		it("returns true for new_task and new_tasks", () => {
			expect(isDelegationTool("new_task")).toBe(true)
			expect(isDelegationTool("new_tasks")).toBe(true)
			expect(DELEGATION_TOOL_NAMES).toEqual(["new_task", "new_tasks"])
		})

		it("returns false for other tools and non-strings", () => {
			expect(isDelegationTool("read_file")).toBe(false)
			expect(isDelegationTool("switch_mode")).toBe(false)
			expect(isDelegationTool("new_task_x")).toBe(false)
			expect(isDelegationTool(undefined)).toBe(false)
			expect(isDelegationTool(42)).toBe(false)
		})
	})

	describe("delegationTruncationMessage", () => {
		it("keeps the existing new_task text unchanged", () => {
			expect(delegationTruncationMessage("new_task")).toBe(
				"This tool was not executed because new_task was called in the same message turn. The new_task tool must be the last tool in a message.",
			)
		})

		it("names new_tasks when new_tasks caused the truncation", () => {
			const message = delegationTruncationMessage("new_tasks")
			expect(message).toContain("new_tasks was called")
			expect(message).toContain("must be the last tool")
		})
	})

	describe("findDelegationToolIndex", () => {
		it("ignores text blocks with a delegation-like name field", () => {
			expect(findDelegationToolIndex([{ type: "text", name: "new_task" }])).toBe(-1)
		})

		it("returns the first delegation tool of either kind", () => {
			expect(
				findDelegationToolIndex([tool("a", "read_file"), tool("b", "new_tasks"), tool("c", "new_task")]),
			).toBe(1)
		})
	})

	describe.each(["new_task", "new_tasks"])("%s isolation", (delegationTool) => {
		it("does not truncate when it is the only tool", () => {
			const result = enforceDelegationIsolation([tool("d1", delegationTool)])
			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("does not truncate when it is the last tool", () => {
			const result = enforceDelegationIsolation([tool("r1", "read_file"), tool("d1", delegationTool)])
			expect(result.truncatedContent).toHaveLength(2)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("truncates later tools and injects error results", () => {
			const result = enforceDelegationIsolation([
				tool("r1", "read_file"),
				tool("d1", delegationTool),
				tool("w1", "write_to_file"),
				tool("e1", "execute_command"),
			])
			expect(result.truncatedContent.map((b) => (b as Anthropic.ToolUseBlockParam).id)).toEqual(["r1", "d1"])
			expect(result.injectedToolResults.map((r) => r.tool_use_id)).toEqual(["w1", "e1"])
			for (const r of result.injectedToolResults) {
				expect(r.is_error).toBe(true)
				expect(r.content).toBe(delegationTruncationMessage(delegationTool))
			}
		})

		it("truncates trailing text without a tool_result", () => {
			const result = enforceDelegationIsolation([tool("d1", delegationTool), { type: "text", text: "Done." }])
			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0)
		})

		it("does not inject a result for a later tool without an id", () => {
			const result = enforceDelegationIsolation([
				tool("d1", delegationTool),
				{ type: "tool_use", name: "read_file", input: {} } as any,
			])
			expect(result.truncatedContent).toHaveLength(1)
			expect(result.injectedToolResults).toHaveLength(0)
		})
	})

	it("keeps only the first delegation tool when new_task and new_tasks are mixed", () => {
		const result = enforceDelegationIsolation([tool("d1", "new_tasks"), tool("d2", "new_task")])
		expect(result.truncatedContent).toHaveLength(1)
		expect(result.injectedToolResults).toHaveLength(1)
		expect(result.injectedToolResults[0].tool_use_id).toBe("d2")
		expect(result.injectedToolResults[0].content).toContain("new_tasks was called")
	})
})
