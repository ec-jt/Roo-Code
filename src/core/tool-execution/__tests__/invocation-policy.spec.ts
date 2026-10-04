import type { McpToolUse, ToolUse } from "../../../shared/tools"
import {
	allowlistedToolPolicy,
	compatibilityToolPolicy,
	evaluateToolPolicy,
	identifyToolInvocation,
	toolIdentityKey,
	type ToolIdentity,
} from "../invocation-policy"

const invocation = (identity: ToolIdentity) => ({
	taskId: "task",
	instanceId: "instance",
	toolCallId: "call",
	identity,
})

describe("tool invocation policy", () => {
	it("defaults to compatibility and requires explicit allowlist membership", async () => {
		const call = invocation({ kind: "builtin", name: "read_file" })
		expect(await evaluateToolPolicy(compatibilityToolPolicy, call)).toEqual({ allow: true })
		expect(await evaluateToolPolicy(allowlistedToolPolicy([]), call)).toMatchObject({ allow: false })
		expect(await evaluateToolPolicy(allowlistedToolPolicy([call.identity]), call)).toEqual({ allow: true })
	})

	it("canonicalizes built-in aliases without granting custom or MCP lookalikes", async () => {
		const policy = allowlistedToolPolicy([{ kind: "builtin", name: "search_and_replace" }])
		expect(await evaluateToolPolicy(policy, invocation({ kind: "builtin", name: "edit" }))).toEqual({ allow: true })
		for (const identity of [
			{ kind: "custom", name: "edit" },
			{ kind: "custom", name: "search_and_replace" },
			{ kind: "mcp", serverName: "host", toolName: "edit" },
		] as const) {
			expect(await evaluateToolPolicy(policy, invocation(identity))).toMatchObject({ allow: false })
		}
	})

	it("selects routes before alias normalization and ignores original display names", () => {
		const block = { type: "tool_use", id: "id", params: {}, partial: false } as ToolUse
		expect(identifyToolInvocation({ ...block, name: "search_and_replace" })).toEqual({
			kind: "builtin",
			name: "edit",
		})
		expect(identifyToolInvocation({ ...block, name: "write_file" as ToolUse["name"] })).toEqual({
			kind: "custom",
			name: "write_file",
		})
		expect(identifyToolInvocation({ ...block, name: "custom_tool", originalName: "read_file" })).toEqual({
			kind: "custom",
			name: "custom_tool",
		})
		expect(
			identifyToolInvocation({
				type: "mcp_tool_use",
				name: "read_file",
				serverName: "s",
				toolName: "t",
			} as McpToolUse),
		).toEqual({ kind: "mcp", serverName: "s", toolName: "t" })
	})

	it("gives the native and wrapper MCP routes the same target identity", () => {
		const native = identifyToolInvocation({ type: "mcp_tool_use", serverName: "s", toolName: "t" } as McpToolUse)
		const wrapper = identifyToolInvocation({
			type: "tool_use",
			name: "use_mcp_tool",
			nativeArgs: { server_name: "s", tool_name: "t" },
		} as ToolUse)
		expect(wrapper).toEqual(native)
		expect(toolIdentityKey(native)).not.toBe(toolIdentityKey({ kind: "builtin", name: "use_mcp_tool" }))
		expect(toolIdentityKey({ kind: "mcp", serverName: "a/b", toolName: "c" })).not.toBe(
			toolIdentityKey({ kind: "mcp", serverName: "a", toolName: "b/c" }),
		)
	})

	it("fails closed on throwing, rejected or malformed policy replies", async () => {
		const call = invocation({ kind: "builtin", name: "read_file" })
		for (const evaluate of [
			vi.fn(() => {
				throw new Error("broken")
			}),
			vi.fn().mockRejectedValue(new Error("broken")),
			vi.fn().mockResolvedValue(undefined),
		]) {
			expect(await evaluateToolPolicy({ evaluate }, call)).toMatchObject({ allow: false })
		}
	})
})
