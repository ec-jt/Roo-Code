import type { ClineMessage, TokenUsage } from "@roo-code/types"

import { taskMetadata } from "../taskMetadata"
import { getApiMetrics } from "../../../shared/getApiMetrics"

vi.mock("../../../utils/storage", () => ({ getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task") }))
vi.mock("get-folder-size", () => ({ default: { loose: vi.fn().mockResolvedValue(100) } }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../../shared/getApiMetrics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getApiMetrics: vi.fn().mockReturnValue({ totalTokensIn: 3, totalTokensOut: 2, totalCost: 1, contextTokens: 5 }),
}))

describe("taskMetadata indexed totals", () => {
	const messages: ClineMessage[] = [
		{ type: "say", say: "text", text: " Task name ", ts: 1 },
		{ type: "say", say: "api_req_started", text: "{}", ts: 2 },
		{ type: "ask", ask: "resume_task", ts: 3 },
	]
	const options = { taskId: "task", taskNumber: 1, messages, globalStoragePath: "/test", workspace: "/workspace" }

	beforeEach(() => vi.clearAllMocks())

	it("uses caller totals without traversing and combining message metrics", async () => {
		const tokenUsage: TokenUsage = { totalTokensIn: 42, totalTokensOut: 7, totalCost: 0.5, contextTokens: 49 }
		const result = await taskMetadata({ ...options, tokenUsage })
		expect(getApiMetrics).not.toHaveBeenCalled()
		expect(result.tokenUsage).toBe(tokenUsage)
		expect(result.historyItem).toMatchObject({
			task: "Task name",
			ts: 2,
			tokensIn: 42,
			tokensOut: 7,
			totalCost: 0.5,
		})
	})

	it("keeps the legacy calculation when totals are not provided", async () => {
		const result = await taskMetadata(options)
		expect(getApiMetrics).toHaveBeenCalledOnce()
		expect(result.historyItem).toMatchObject({ tokensIn: 3, tokensOut: 2, totalCost: 1 })
	})

	it("keeps empty histories at zero even if stale caller totals are provided", async () => {
		const result = await taskMetadata({
			...options,
			messages: [],
			tokenUsage: { totalTokensIn: 42, totalTokensOut: 7, totalCost: 0.5, contextTokens: 49 },
		})
		expect(getApiMetrics).not.toHaveBeenCalled()
		expect(result.historyItem).toMatchObject({ tokensIn: 0, tokensOut: 0, totalCost: 0 })
	})
})
