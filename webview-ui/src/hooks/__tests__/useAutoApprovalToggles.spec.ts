import { renderHook } from "@testing-library/react"
import { useAutoApprovalToggles } from "../useAutoApprovalToggles"

const state = vi.hoisted(() => ({ alwaysAllowNestedSubtasks: false, alwaysAllowAll: true }))
vi.mock("@src/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

describe("nested-subtask toggle state", () => {
	it("exposes and refreshes nested approval independently of All actions", () => {
		const { result, rerender } = renderHook(() => useAutoApprovalToggles())
		expect(result.current.alwaysAllowNestedSubtasks).toBe(false)
		state.alwaysAllowNestedSubtasks = true
		rerender()
		expect(result.current.alwaysAllowNestedSubtasks).toBe(true)
		state.alwaysAllowNestedSubtasks = false
		rerender()
		expect(result.current.alwaysAllowNestedSubtasks).toBe(false)
	})
})
