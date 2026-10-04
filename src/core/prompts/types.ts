/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	/** Durable ancestry depth; undefined means ancestry is not verified. */
	delegationDepth?: number
	/** Effective opt-in after checking the master/category gates and mandatory approval fence. */
	nestedSubtaskAutoApprovalEnabled?: boolean
	browserToolEnabled?: boolean
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .roo/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
}
