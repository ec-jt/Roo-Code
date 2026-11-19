import { NativeToolCallParser } from "../NativeToolCallParser"
import type { ToolUse } from "../../../shared/tools"

// Exact loose payloads observed from DeepSeek (deepseek-flash) in a live Cordis run.
const ops = JSON.stringify([{ op: "set", field: "nextAction", value: "Run tests" }])
const revision = "a".repeat(64)
const memoryId = "11111111-1111-4111-8111-111111111111"

const parse = (name: string, args: unknown) =>
	NativeToolCallParser.parseToolCallOrError({
		id: "call",
		name,
		arguments: typeof args === "string" ? args : JSON.stringify(args),
	}) as ToolUse

describe("NativeToolCallParser loose task_state and memory arguments", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("task_state", () => {
		it('accepts DeepSeek read with operations "" and no expected_revision', () => {
			const result = parse("task_state", { action: "read", operations: "" })
			expect(result.argumentError).toBeUndefined()
			expect(result.nativeArgs).toEqual({ action: "read", expected_revision: null, operations: null })
		})

		it("accepts whitespace-only values and a bare read", () => {
			expect(
				parse("task_state", { action: "read", expected_revision: "  ", operations: "\n" }).nativeArgs,
			).toEqual({ action: "read", expected_revision: null, operations: null })
			expect(parse("task_state", { action: "read" }).nativeArgs).toEqual({
				action: "read",
				expected_revision: null,
				operations: null,
			})
		})

		it('accepts the literal string "null" (case-insensitive, trimmed) as null', () => {
			// Exact DeepSeek payload from the 4.2.85 live check.
			const result = parse("task_state", { action: "read", operations: "null" })
			expect(result.argumentError).toBeUndefined()
			expect(result.nativeArgs).toEqual({ action: "read", expected_revision: null, operations: null })
			expect(
				parse("task_state", { action: "read", expected_revision: "NULL ", operations: " Null" }).nativeArgs,
			).toEqual({ action: "read", expected_revision: null, operations: null })
			const patch = parse("task_state", { action: "patch", expected_revision: "null", operations: ops })
			expect(patch.argumentError).toBeUndefined()
			expect(patch.nativeArgs).toEqual({ action: "patch", expected_revision: null, operations: ops })
		})

		it("passes DeepSeek patch without expected_revision to the tool (no schema failure)", () => {
			const result = parse("task_state", { action: "patch", operations: ops })
			expect(result.argumentError).toBeUndefined()
			expect(result.nativeArgs).toEqual({ action: "patch", expected_revision: null, operations: ops })
		})

		it("keeps strict-form calls unchanged", () => {
			expect(
				parse("task_state", { action: "read", expected_revision: null, operations: null }).nativeArgs,
			).toEqual({ action: "read", expected_revision: null, operations: null })
			expect(
				parse("task_state", { action: "patch", expected_revision: revision, operations: ops }).nativeArgs,
			).toEqual({ action: "patch", expected_revision: revision, operations: ops })
		})

		it("still rejects invalid payloads", () => {
			expect(
				parse("task_state", { action: "patch", expected_revision: revision, operations: "" }).argumentError,
			).toBeDefined()
			expect(
				parse("task_state", { action: "read", expected_revision: revision, operations: null }).argumentError,
			).toBeDefined()
			expect(parse("task_state", { action: "read", extra: 1 }).argumentError).toBeDefined()
			expect(parse("task_state", { action: "patch", operations: "not json" }).argumentError).toBeDefined()
		})
	})

	describe("memory", () => {
		it("treats missing or empty expected_revision as null for list and read", () => {
			expect(parse("memory", { action: "list", scope: "project" }).nativeArgs).toEqual({
				action: "list",
				scope: "project",
				expected_revision: null,
			})
			expect(
				parse("memory", { action: "read", scope: "project", id: memoryId, expected_revision: "" }).nativeArgs,
			).toMatchObject({ action: "read", id: memoryId, expected_revision: null })
		})

		it('treats the literal string "null" as null for expected_revision, id and type', () => {
			expect(
				parse("memory", { action: "list", scope: "project", expected_revision: "null", id: "NULL " })
					.nativeArgs,
			).toEqual({ action: "list", scope: "project", expected_revision: null, id: null })
			const del = parse("memory", {
				action: "delete",
				scope: "project",
				id: memoryId,
				expected_revision: "NULL ",
			})
			expect(del.argumentError).toBeUndefined()
			expect(del.nativeArgs).toMatchObject({ action: "delete", id: memoryId, expected_revision: null })
		})

		it("passes delete without expected_revision to the tool (no schema failure)", () => {
			const result = parse("memory", { action: "delete", scope: "project", id: memoryId })
			expect(result.argumentError).toBeUndefined()
			expect(result.nativeArgs).toMatchObject({ action: "delete", expected_revision: null })
		})

		it("keeps strict-form calls unchanged", () => {
			const strict = {
				action: "delete",
				scope: "project",
				id: memoryId,
				name: null,
				description: null,
				type: null,
				body: null,
				expected_revision: revision,
				query: null,
			}
			expect(parse("memory", strict).nativeArgs).toEqual(strict)
		})

		it("still rejects invalid payloads", () => {
			expect(parse("memory", { action: "read", scope: "project" }).argumentError).toBeDefined()
			expect(
				parse("memory", { action: "list", scope: "project", expected_revision: revision }).argumentError,
			).toBeDefined()
		})
	})
})
