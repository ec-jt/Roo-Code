// npx vitest run api/providers/utils/__tests__/timeout-config.spec.ts

import { getApiRequestTimeout } from "../timeout-config"
import * as vscode from "vscode"

// Mock vscode
vitest.mock("vscode", () => ({
	workspace: {
		getConfiguration: vitest.fn().mockReturnValue({
			get: vitest.fn(),
		}),
	},
}))

describe("getApiRequestTimeout", () => {
	let mockGetConfig: any

	beforeEach(() => {
		vitest.clearAllMocks()
		mockGetConfig = vitest.fn()
		;(vscode.workspace.getConfiguration as any).mockReturnValue({
			get: mockGetConfig,
		})
	})

	it("should default to no timeout (undefined) when no configuration is set", () => {
		mockGetConfig.mockReturnValue(0)

		const timeout = getApiRequestTimeout()

		expect(vscode.workspace.getConfiguration).toHaveBeenCalledWith("roo-cline")
		expect(mockGetConfig).toHaveBeenCalledWith("apiRequestTimeout", 0)
		// Default is no client-side timeout so background/hidden-tab tasks keep running
		expect(timeout).toBeUndefined()
	})

	it("should return custom timeout in milliseconds", () => {
		mockGetConfig.mockReturnValue(1200) // 20 minutes

		const timeout = getApiRequestTimeout()

		expect(timeout).toBe(1200000) // 1200 seconds in milliseconds
	})

	it("should return undefined for zero timeout (disables timeout)", () => {
		mockGetConfig.mockReturnValue(0)

		const timeout = getApiRequestTimeout()

		// Zero means "no timeout" - return undefined so SDK uses its default
		// (OpenAI SDK interprets 0 as "abort immediately", so we avoid that)
		expect(timeout).toBeUndefined()
	})

	it("should return undefined for negative values (disables timeout)", () => {
		mockGetConfig.mockReturnValue(-100)

		const timeout = getApiRequestTimeout()

		// Negative values also mean "no timeout" - return undefined
		expect(timeout).toBeUndefined()
	})

	it("should handle null by using no-timeout default", () => {
		mockGetConfig.mockReturnValue(null)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBeUndefined() // Invalid value -> no timeout
	})

	it("should handle undefined by using no-timeout default", () => {
		mockGetConfig.mockReturnValue(undefined)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBeUndefined() // Invalid value -> no timeout
	})

	it("should handle NaN by using no-timeout default", () => {
		mockGetConfig.mockReturnValue(NaN)

		const timeout = getApiRequestTimeout()

		expect(timeout).toBeUndefined() // Invalid value -> no timeout
	})

	it("should handle string values by using no-timeout default", () => {
		mockGetConfig.mockReturnValue("not-a-number") // String instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBeUndefined() // Invalid value -> no timeout
	})

	it("should handle boolean values by using no-timeout default", () => {
		mockGetConfig.mockReturnValue(true) // Boolean instead of number

		const timeout = getApiRequestTimeout()

		expect(timeout).toBeUndefined() // Invalid value -> no timeout
	})
})
