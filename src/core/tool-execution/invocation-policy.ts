import { toolNames } from "@roo-code/types"

import { TOOL_ALIASES, type McpToolUse, type ToolUse } from "../../shared/tools"

/** Namespaces describe the execution route, never a model-supplied display name. */
export type ToolIdentity =
	| { readonly kind: "builtin"; readonly name: string }
	| { readonly kind: "custom"; readonly name: string }
	| { readonly kind: "mcp"; readonly serverName: string; readonly toolName: string }

export interface ToolInvocation {
	readonly taskId: string
	readonly instanceId: string
	readonly toolCallId: string
	readonly identity: ToolIdentity
}

export type InvocationDecision = { allow: true } | { allow: false; reason: string }

/** Additional capability restriction, not a replacement for existing validation or approval. */
export interface ToolInvocationPolicy {
	evaluate(invocation: ToolInvocation): InvocationDecision | Promise<InvocationDecision>
}

export const compatibilityToolPolicy: ToolInvocationPolicy = {
	evaluate: () => ({ allow: true }),
}

function canonicalBuiltin(name: string): string {
	return Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name
}

/** Tuple encoding prevents delimiter collisions and cross-namespace grants. */
export function toolIdentityKey(identity: ToolIdentity): string {
	return identity.kind === "mcp"
		? JSON.stringify([identity.kind, identity.serverName, identity.toolName])
		: JSON.stringify([identity.kind, identity.kind === "builtin" ? canonicalBuiltin(identity.name) : identity.name])
}

export function allowlistedToolPolicy(identities: readonly ToolIdentity[]): ToolInvocationPolicy {
	const allowed = new Set(identities.map(toolIdentityKey))
	return {
		evaluate: ({ identity }) =>
			allowed.has(toolIdentityKey(identity))
				? { allow: true }
				: { allow: false, reason: "Tool is not in the task capability allowlist." },
	}
}

/**
 * Mirrors the presenter's route precedence. Aliases are canonicalized only AFTER
 * selecting the built-in route; a custom tool named write_file is still custom.
 * MCP wrapper and native calls share a target identity, not a blanket wrapper grant.
 * MCP names here must subsequently be resolved against the host's actual catalog.
 */
export function identifyToolInvocation(block: ToolUse | McpToolUse): ToolIdentity {
	if (block.type === "mcp_tool_use") {
		return { kind: "mcp", serverName: block.serverName, toolName: block.toolName }
	}
	if (block.name === "use_mcp_tool" && block.nativeArgs) {
		const args = block.nativeArgs as { server_name?: string; tool_name?: string }
		if (typeof args.server_name === "string" && typeof args.tool_name === "string") {
			return { kind: "mcp", serverName: args.server_name, toolName: args.tool_name }
		}
	}

	// custom_tool is a telemetry label, not a built-in handler.
	if (block.name !== "custom_tool" && (toolNames as readonly string[]).includes(block.name)) {
		return { kind: "builtin", name: canonicalBuiltin(block.name) }
	}
	return { kind: "custom", name: block.name }
}

export async function evaluateToolPolicy(
	policy: ToolInvocationPolicy,
	invocation: ToolInvocation,
): Promise<InvocationDecision> {
	try {
		const decision = await policy.evaluate(invocation)
		if (decision?.allow === true) return { allow: true }
		return { allow: false, reason: decision?.reason || "Tool invocation denied by task policy." }
	} catch {
		return { allow: false, reason: "Tool invocation policy failed. Execution denied." }
	}
}
