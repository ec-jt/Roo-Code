// npx vitest run core/task/parallel/__tests__/BatchAdmissionRuntime.spec.ts

import { ModelDispatchControl, type DispatchAdmission } from "../../../../api/dispatch-admission"
import { mediateModelHandler } from "../../../../api/mediated-handler"
import {
	BatchAdmissionRuntime,
	DEFAULT_PARALLEL_CONCURRENCY,
	DEFAULT_PARALLEL_TOKEN_BUDGET,
	clampConcurrency,
	normalizeTokenBudget,
} from "../BatchAdmissionRuntime"
import { PARALLEL_REFUSAL_MESSAGE, decideNonInteractiveAsk, parallelChildToolPolicy } from "../non-interactive"

const descriptor = {
	operationId: "op",
	dispatchId: "d",
	purpose: "chat" as const,
	provider: "openai",
	model: "m",
	maxOutputTokens: 1,
}
type Granted = Extract<DispatchAdmission, { outcome: "granted" }>

describe("BatchAdmissionRuntime", () => {
	it("clamps concurrency to 1..4 and defaults the budget", () => {
		expect(clampConcurrency(undefined)).toBe(DEFAULT_PARALLEL_CONCURRENCY)
		expect(clampConcurrency(0)).toBe(1)
		expect(clampConcurrency(9)).toBe(4)
		expect(clampConcurrency(3)).toBe(3)
		expect(normalizeTokenBudget(undefined)).toBe(DEFAULT_PARALLEL_TOKEN_BUDGET)
		expect(normalizeTokenBudget(-1)).toBe(DEFAULT_PARALLEL_TOKEN_BUDGET)
		expect(new BatchAdmissionRuntime().providerScope).toBe("any")
	})

	it("holds extra requests until a slot frees", async () => {
		const runtime = new BatchAdmissionRuntime({ concurrency: 1 })
		const first = (await runtime.admit(descriptor, new AbortController().signal)) as Granted
		let second: Granted | undefined
		const pending = runtime.admit(descriptor, new AbortController().signal).then((g) => (second = g as Granted))
		await new Promise((r) => setTimeout(r, 20))
		expect(second).toBeUndefined()
		expect(runtime.activeRequests).toBe(1)
		first.settle("completed")
		first.settle("completed") // idempotent
		await pending
		expect(second?.outcome).toBe("granted")
		expect(runtime.activeRequests).toBe(1)
	})

	it("cancels a waiting request when its signal aborts", async () => {
		const runtime = new BatchAdmissionRuntime({ concurrency: 1 })
		await runtime.admit(descriptor, new AbortController().signal)
		const controller = new AbortController()
		const waiting = runtime.admit(descriptor, controller.signal)
		controller.abort()
		await expect(waiting).rejects.toMatchObject({ code: "cancelled" })
	})

	it("denies admission once reported usage reaches the budget, including waiting requests", async () => {
		const runtime = new BatchAdmissionRuntime({ concurrency: 1, tokenBudget: 100 })
		const first = (await runtime.admit(descriptor, new AbortController().signal)) as Granted
		const waiting = runtime.admit(descriptor, new AbortController().signal)
		runtime.recordUsage({ inputTokens: 60, outputTokens: 40 })
		first.settle("completed")
		await expect(waiting).resolves.toEqual({ outcome: "budget-denied" })
		await expect(runtime.admit(descriptor, new AbortController().signal)).resolves.toEqual({
			outcome: "budget-denied",
		})
		expect(runtime.usedTokens).toBe(100)
	})

	it("mediates any provider handler and reports usage before settlement", async () => {
		const runtime = new BatchAdmissionRuntime({ concurrency: 2, tokenBudget: 1_000 })
		const handler = {
			getModel: () => ({ id: "gpt-x", info: { contextWindow: 1, maxTokens: 7, supportsPromptCache: false } }),
			countTokens: async () => 0,
			createMessage: () =>
				(async function* () {
					yield { type: "text" as const, text: "hi" }
					yield { type: "usage" as const, inputTokens: 5, outputTokens: 3 }
				})(),
		}
		const admit = vi.spyOn(runtime, "admit")
		const mediated = mediateModelHandler(handler as any, {
			runtime,
			operationId: "op",
			purpose: "chat",
			signal: new AbortController().signal,
			isCurrent: () => true,
			provider: "openai",
		})
		const chunks = []
		for await (const chunk of mediated.createMessage("s", [])) chunks.push(chunk)
		expect(chunks).toHaveLength(2)
		expect(admit.mock.calls[0][0]).toMatchObject({ provider: "openai", model: "gpt-x", maxOutputTokens: 7 })
		expect(runtime.usedTokens).toBe(8)
		expect(runtime.activeRequests).toBe(0)
	})

	it("keeps the preview runtime Anthropic-only", () => {
		const preview = { admit: vi.fn() }
		expect(() =>
			mediateModelHandler({ createMessage: vi.fn(), getModel: vi.fn(), countTokens: vi.fn() } as any, {
				runtime: preview,
				operationId: "op",
				purpose: "chat",
				signal: new AbortController().signal,
				isCurrent: () => true,
			}),
		).toThrow(ModelDispatchControl)
	})
})

describe("non-interactive decisions", () => {
	it("accepts completion, stops on terminal asks and refuses everything else", () => {
		expect(decideNonInteractiveAsk("completion_result", "")).toEqual({ response: "yesButtonClicked" })
		expect(decideNonInteractiveAsk("resume_task", "")).toMatchObject({
			response: "noButtonClicked",
			stop: "resume_task",
		})
		expect(decideNonInteractiveAsk("api_req_failed", "x")).toMatchObject({ stop: "api_req_failed" })
		for (const type of [
			"tool",
			"command",
			"followup",
			"use_mcp_server",
			"browser_action_launch",
			"plan_review",
		] as const) {
			const decision = decideNonInteractiveAsk(type, '{"tool":"newFileCreated","path":"a.txt"}')
			expect(decision.response).toBe("noButtonClicked")
			expect(decision.text).toBe(PARALLEL_REFUSAL_MESSAGE)
			expect(decision.refused?.type).toBe(type)
		}
		expect(decideNonInteractiveAsk("tool", '{"tool":"newFileCreated","path":"a.txt"}').refused).toEqual({
			type: "tool",
			tool: "newFileCreated",
			detail: "a.txt",
		})
	})

	it("denies delegation and mode switches by capability, never grants", async () => {
		const refused: unknown[] = []
		const policy = parallelChildToolPolicy((r) => refused.push(r))
		const call = (name: string) =>
			policy.evaluate({ taskId: "t", instanceId: "i", toolCallId: "c", identity: { kind: "builtin", name } })
		expect(await call("new_task")).toMatchObject({ allow: false, reason: PARALLEL_REFUSAL_MESSAGE })
		expect(await call("new_tasks")).toMatchObject({ allow: false })
		expect(await call("switch_mode")).toMatchObject({ allow: false })
		expect(await call("write_to_file")).toEqual({ allow: true })
		expect(refused).toHaveLength(3)
	})
})
