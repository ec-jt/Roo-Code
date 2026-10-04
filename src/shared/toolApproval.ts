import type { ClineMessage, ClineSayTool } from "@roo-code/types"

/** The Read permission includes native network retrieval, but not browser interaction. */
export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	if (tool.tool === "fileSystem") {
		return ["read_text_file", "list_directory", "search_files"].includes(tool.action ?? "")
	}
	if (tool.tool === "gitTools") {
		return ["status", "working_state", "search_commits", "commit_info"].includes(tool.action ?? "")
	}
	if (tool.tool === "gitRepoResearch") {
		return ["search_commits", "get_commit_info", "get_working_state"].includes(tool.action ?? "")
	}
	return [
		"readFile",
		"readCommandOutput",
		"listFiles",
		"listFilesTopLevel",
		"listFilesRecursive",
		"searchFiles",
		"codebaseSearch",
		"runSlashCommand",
		"markdownify",
		"braveWebSearch",
		"braveLocalSearch",
		"context7ResolveLibraryId",
		"context7QueryDocs",
	].includes(tool.tool)
}

/** Outside-workspace access must be enabled separately in settings. */
export function canAlwaysAllowReadOnly(message: ClineMessage | undefined, allowOutsideWorkspace = false): boolean {
	if (!message || message.type !== "ask" || message.ask !== "tool" || message.partial || message.isAnswered) {
		return false
	}
	try {
		const tool: ClineSayTool | null = JSON.parse(message.text ?? "null")
		return !!tool && isReadOnlyToolAction(tool) && (!tool.isOutsideWorkspace || allowOutsideWorkspace)
	} catch {
		return false
	}
}
