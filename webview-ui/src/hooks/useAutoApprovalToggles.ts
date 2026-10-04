import { useMemo } from "react"
import { useExtensionState } from "@src/context/ExtensionStateContext"

/**
 * Custom hook that creates and returns the auto-approval toggles object
 * This encapsulates the logic for creating the toggles object from extension state
 */
export function useAutoApprovalToggles() {
	const {
		alwaysAllowAll,
		alwaysAllowReadOnly,
		alwaysAllowWrite,
		alwaysAllowBrowser,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowNestedSubtasks,
		alwaysAllowFollowupQuestions,
	} = useExtensionState()

	const toggles = useMemo(
		() => ({
			alwaysAllowAll,
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowBrowser,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowNestedSubtasks,
			alwaysAllowFollowupQuestions,
		}),
		[
			alwaysAllowAll,
			alwaysAllowReadOnly,
			alwaysAllowWrite,
			alwaysAllowBrowser,
			alwaysAllowExecute,
			alwaysAllowMcp,
			alwaysAllowModeSwitch,
			alwaysAllowSubtasks,
			alwaysAllowNestedSubtasks,
			alwaysAllowFollowupQuestions,
		],
	)

	return toggles
}
