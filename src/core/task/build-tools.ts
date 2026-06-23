import path from "path"

import type OpenAI from "openai"

import type { ProviderSettings, ModeConfig, ModelInfo } from "@roo-code/types"
import { customToolRegistry, formatNative } from "@roo-code/core"

import type { ClineProvider } from "../webview/ClineProvider"
import { getRooDirectoriesForCwd } from "../../services/roo-config/index.js"

import { getNativeTools, getMcpServerTools } from "../prompts/tools/native-tools"
import {
	filterNativeToolsForMode,
	filterMcpToolsForMode,
	resolveToolAlias,
} from "../prompts/tools/filter-tools-for-mode"

interface BuildToolsOptions {
	provider: ClineProvider
	cwd: string
	mode: string | undefined
	customModes: ModeConfig[] | undefined
	experiments: Record<string, boolean> | undefined
	apiConfiguration: ProviderSettings | undefined
	browserToolEnabled?: boolean
	disabledTools?: string[]
	modelInfo?: ModelInfo
	/**
	 * If true, returns all tools without mode filtering, but also includes
	 * the list of allowed tool names for use with allowedFunctionNames.
	 * This enables providers that support function call restrictions (e.g., Gemini)
	 * to pass all tool definitions while restricting callable tools.
	 */
	includeAllToolsWithRestrictions?: boolean
}

interface BuildToolsResult {
	/**
	 * The tools to pass to the model.
	 * If includeAllToolsWithRestrictions is true, this includes ALL tools.
	 * Otherwise, it includes only mode-filtered tools.
	 */
	tools: OpenAI.Chat.ChatCompletionTool[]
	/**
	 * The names of tools that are allowed to be called based on mode restrictions.
	 * Only populated when includeAllToolsWithRestrictions is true.
	 * Use this with allowedFunctionNames in providers that support it.
	 */
	allowedFunctionNames?: string[]
}

/**
 * Extracts the function name from a tool definition.
 */
function getToolName(tool: OpenAI.Chat.ChatCompletionTool): string {
	return (tool as OpenAI.Chat.ChatCompletionFunctionTool).function.name
}

/**
 * Builds the complete tools array for native protocol requests.
 * Combines native tools and MCP tools, filtered by mode restrictions.
 *
 * @param options - Configuration options for building the tools
 * @returns Array of filtered native and MCP tools
 */
export async function buildNativeToolsArray(options: BuildToolsOptions): Promise<OpenAI.Chat.ChatCompletionTool[]> {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return result.tools
}

/**
 * Builds the complete tools array for native protocol requests with optional mode restrictions.
 * When includeAllToolsWithRestrictions is true, returns ALL tools but also provides
 * the list of allowed tool names for use with allowedFunctionNames.
 *
 * This enables providers like Gemini to pass all tool definitions to the model
 * (so it can reference historical tool calls) while restricting which tools
 * can actually be invoked via allowedFunctionNames in toolConfig.
 *
 * @param options - Configuration options for building the tools
 * @returns BuildToolsResult with tools array and optional allowedFunctionNames
 */
export async function buildNativeToolsArrayWithRestrictions(options: BuildToolsOptions): Promise<BuildToolsResult> {
	const {
		provider,
		cwd,
		mode,
		customModes,
		experiments,
		apiConfiguration,
		browserToolEnabled,
		disabledTools,
		modelInfo,
		includeAllToolsWithRestrictions,
	} = options

	const mcpHub = provider.getMcpHub()

	// Get CodeIndexManager for feature checking.
	const { CodeIndexManager } = await import("../../services/code-index/manager")
	const codeIndexManager = CodeIndexManager.getInstance(provider.context, cwd)

	// Build settings object for tool filtering.
	const filterSettings = {
		browserToolEnabled: browserToolEnabled ?? true,
		todoListEnabled: apiConfiguration?.todoListEnabled ?? true,
		disabledTools,
		modelInfo,
	}

	// Check if the model supports images for read_file tool description.
	const supportsImages = modelInfo?.supportsImages ?? false

	// Build native tools with dynamic read_file tool based on settings.
	let nativeTools = getNativeTools({
		supportsImages,
	})

	// Per-tool enable map and credentials live in extension state.
	// We resolve them here so the gating works for every call site without
	// changing the BuildToolsOptions shape used by callers.
	const state = await provider.getState()
	const nativeToolEnabled = (state as any)?.nativeToolEnabled as Record<string, boolean> | undefined
	const braveApiKey = (state as any)?.braveApiKey as string | undefined
	const context7ApiKey = (state as any)?.context7ApiKey as string | undefined
	const githubToken = (state as any)?.githubToken as string | undefined

	// Build the set of tool names that should be excluded because the user
	// turned them off in Settings → Experimental → Native Tool Integrations
	// OR because a required credential is missing.
	const nativeToolGate = new Set<string>()
	const isUserEnabled = (name: string): boolean => {
		if (!nativeToolEnabled) return true
		const v = nativeToolEnabled[name]
		return v !== false
	}
	const CREDENTIAL_REQUIREMENTS: Record<string, string | undefined> = {
		brave_web_search: braveApiKey,
		brave_local_search: braveApiKey,
		context7_resolve_library_id: context7ApiKey,
		context7_query_docs: context7ApiKey,
		// git_* tools work without a token on public repos; we only auto-disable
		// them when the user has explicitly toggled them off.
	}
	for (const name of [
		"brave_web_search",
		"brave_local_search",
		"context7_resolve_library_id",
		"context7_query_docs",
		"file_system",
		"markdownify",
		"git_tools",
		"git_repo_research",
	]) {
		const requiredCred = CREDENTIAL_REQUIREMENTS[name]
		if (!isUserEnabled(name)) {
			nativeToolGate.add(name)
			continue
		}
		if (requiredCred !== undefined && !requiredCred) {
			nativeToolGate.add(name)
		}
	}

	if (nativeToolGate.size > 0) {
		nativeTools = nativeTools.filter((t) => {
			const fnName = (t as any)?.function?.name as string | undefined
			return !fnName || !nativeToolGate.has(fnName)
		})
	}

	// Expose the resolved token to subprocess-spawning tools (git) so the
	// underlying `git` CLI can authenticate against private GitHub remotes.
	// We set GH_TOKEN/GITHUB_TOKEN on process.env so child `git` processes
	// inherit them. The setter is idempotent.
	if (githubToken) {
		process.env.GH_TOKEN = githubToken
		process.env.GITHUB_TOKEN = githubToken
	}

	// Filter native tools based on mode restrictions.
	const filteredNativeTools = filterNativeToolsForMode(
		nativeTools,
		mode,
		customModes,
		experiments,
		codeIndexManager,
		filterSettings,
		mcpHub,
	)

	// Filter MCP tools based on mode restrictions.
	const mcpTools = getMcpServerTools(mcpHub)
	const filteredMcpTools = filterMcpToolsForMode(mcpTools, mode, customModes, experiments)

	// Add custom tools if they are available and the experiment is enabled.
	let nativeCustomTools: OpenAI.Chat.ChatCompletionFunctionTool[] = []

	if (experiments?.customTools) {
		const toolDirs = getRooDirectoriesForCwd(cwd).map((dir) => path.join(dir, "tools"))
		await customToolRegistry.loadFromDirectoriesIfStale(toolDirs)
		const customTools = customToolRegistry.getAllSerialized()

		if (customTools.length > 0) {
			nativeCustomTools = customTools.map(formatNative)
		}
	}

	// Combine filtered tools (for backward compatibility and for allowedFunctionNames)
	const filteredTools = [...filteredNativeTools, ...filteredMcpTools, ...nativeCustomTools]

	// If includeAllToolsWithRestrictions is true, return ALL tools but provide
	// allowed names based on mode filtering
	if (includeAllToolsWithRestrictions) {
		// Combine ALL tools (unfiltered native + all MCP + custom)
		const allTools = [...nativeTools, ...mcpTools, ...nativeCustomTools]

		// Extract names of tools that are allowed based on mode filtering.
		// Resolve any alias names to canonical names to ensure consistency with allTools
		// (which uses canonical names). This prevents Gemini errors when tools are renamed
		// to aliases in filteredTools but allTools contains the original canonical names.
		const allowedFunctionNames = filteredTools.map((tool) => resolveToolAlias(getToolName(tool)))

		return {
			tools: allTools,
			allowedFunctionNames,
		}
	}

	// Default behavior: return only filtered tools
	return {
		tools: filteredTools,
	}
}
