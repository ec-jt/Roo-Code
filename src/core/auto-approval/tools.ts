import type { ClineSayTool } from "@roo-code/types"

export { isReadOnlyToolAction } from "../../shared/toolApproval"

export function isWriteToolAction(tool: ClineSayTool): boolean {
	return ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"].includes(tool.tool)
}
