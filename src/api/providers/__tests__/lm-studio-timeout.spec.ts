// npx vitest run api/providers/__tests__/lm-studio-timeout.spec.ts

import { LmStudioHandler } from "../lm-studio"
import { ApiHandlerOptions } from "../../../shared/api"

// Mock the timeout config utility
vitest.mock("../utils/timeout-config", () => ({
	getApiRequestTimeout: vitest.fn(),
}))

import { getApiRequestTimeout } from "../utils/timeout-config"

// Mock OpenAI
const mockOpenAIConstructor = vitest.fn()
vitest.mock("openai", () => {
	return {
		__esModule: true,
		default: vitest.fn().mockImplementation((config) => {
			mockOpenAIConstructor(config)
			return {
				chat: {
					completions: {
						create: vitest.fn(),
					},
				},
			}
		}),
	}
})

describe("LmStudioHandler timeout configuration", () => {
	it.each([undefined, "", "   ", "test-token"])("normalizes /v1 and supports optional token %s", (token) => {
		new LmStudioHandler({ lmStudioBaseUrl: "http://server:1234/v1/", lmStudioApiKey: token })
		expect(mockOpenAIConstructor).toHaveBeenLastCalledWith(
			expect.objectContaining({
				baseURL: "http://server:1234/v1",
				apiKey: token?.trim() || "noop",
				...(!token?.trim() ? { defaultHeaders: { Authorization: null } } : {}),
			}),
		)
		if (token?.trim()) expect(mockOpenAIConstructor.mock.calls.at(-1)?.[0].defaultHeaders).toBeUndefined()
	})
	beforeEach(() => {
		vitest.clearAllMocks()
	})

	it("should use the unlimited default for the adapted client", () => {
		;(getApiRequestTimeout as any).mockReturnValue(0)

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
			lmStudioBaseUrl: "http://localhost:1234",
		}

		new LmStudioHandler(options)

		expect(getApiRequestTimeout).toHaveBeenCalled()
		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "http://localhost:1234/v1",
				apiKey: "noop",
				timeout: 0,
			}),
		)
	})

	it("should use custom timeout when configuration is set", () => {
		;(getApiRequestTimeout as any).mockReturnValue(1200000) // 20 minutes

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
			lmStudioBaseUrl: "http://localhost:1234",
		}

		new LmStudioHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 1200000, // 1200 seconds in milliseconds
			}),
		)
	})

	it("should handle zero timeout (no timeout)", () => {
		;(getApiRequestTimeout as any).mockReturnValue(0)

		const options: ApiHandlerOptions = {
			apiModelId: "llama2",
			lmStudioModelId: "llama2",
		}

		new LmStudioHandler(options)

		expect(mockOpenAIConstructor).toHaveBeenCalledWith(
			expect.objectContaining({
				timeout: 0, // No timeout
			}),
		)
	})
})
