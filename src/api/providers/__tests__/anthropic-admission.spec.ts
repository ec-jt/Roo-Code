import type { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicHandler } from "../anthropic"
import { mediateModelHandler } from "../../mediated-handler"
import { ModelDispatchControl, type DispatchAdmission, type ModelDispatchContext } from "../../dispatch-admission"
import type { ApiHandler } from "../../index"
import { summarizeConversation } from "../../../core/condense"
import { manageContext } from "../../../core/context-management"

const { create, construct } = vi.hoisted(() => ({ create: vi.fn(), construct: vi.fn() }))
vi.mock("@anthropic-ai/sdk", () => ({
	Anthropic: vi.fn().mockImplementation((options) => {
		construct(options)
		return { messages: { create } }
	}),
}))

async function collect(handler: ApiHandler) {
	const chunks = []
	for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) chunks.push(chunk)
	return chunks
}

describe("Anthropic dispatch admission", () => {
	let controller: AbortController
	let settle: ReturnType<typeof vi.fn>
	let admit: ReturnType<typeof vi.fn>
	let context: ModelDispatchContext
	beforeEach(() => {
		vi.clearAllMocks()
		controller = new AbortController()
		settle = vi.fn()
		admit = vi.fn(async () => ({ outcome: "granted", settle }))
		context = {
			runtime: { admit },
			operationId: "operation",
			purpose: "chat",
			signal: controller.signal,
			isCurrent: () => true,
		}
		create.mockImplementation(async () =>
			(async function* () {
				yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } }
				yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "answer" } }
				yield { type: "message_delta", usage: { output_tokens: 5 } }
				yield { type: "message_stop" }
			})(),
		)
	})

	function handler(id = "claude-sonnet-4-6") {
		const provider = new AnthropicHandler({ apiModelId: id, apiKey: "secret" })

		return mediateModelHandler(provider, context)
	}

	it.each(["claude-sonnet-4-6", "claude-sonnet-5"])(
		"admits the %s branch with signal and no hidden retries",
		async (id) => {
			const chunks = await collect(handler(id))
			expect(admit).toHaveBeenCalledOnce()
			expect(create).toHaveBeenCalledOnce()
			expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0, signal: controller.signal })
			expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", inputTokens: 10 }))
			expect(settle).toHaveBeenCalledExactlyOnceWith("completed")
			expect(JSON.stringify(admit.mock.calls[0][0])).not.toContain("secret")
		},
	)

	it("leaves ordinary SDK options and completePrompt compatibility alone", async () => {
		await collect(new AnthropicHandler({ apiModelId: "claude-sonnet-4-6" }))
		expect(create.mock.calls[0][1]).not.toHaveProperty("maxRetries")
		expect(create.mock.calls[0][1]).not.toHaveProperty("signal")
		expect(admit).not.toHaveBeenCalled()
		expect(handler()).not.toHaveProperty("completePrompt")
	})

	it.each(["budget-wait", "budget-denied", "policy-denied"])("does not dispatch on %s", async (outcome) => {
		admit.mockResolvedValue({ outcome })
		await expect(collect(handler())).rejects.toMatchObject({ code: outcome })
		expect(create).not.toHaveBeenCalled()
		expect(settle).not.toHaveBeenCalled()
	})

	it("rejects unsupported handlers without relying on ignored metadata", () => {
		const unsupported = { createMessage: vi.fn(), getModel: vi.fn(), countTokens: vi.fn() }
		expect(() => mediateModelHandler(unsupported, context)).toThrow(ModelDispatchControl)
		expect(unsupported.createMessage).not.toHaveBeenCalled()
	})

	it("detaches inputs, tools, configuration, model info and SDK credentials before waiting", async () => {
		let grant!: (value: DispatchAdmission) => void
		admit.mockImplementation(
			() =>
				new Promise((resolve) => {
					grant = resolve
				}),
		)
		const options = { apiModelId: "claude-sonnet-4-6", apiKey: "original-key", modelTemperature: 0.2 }
		const original = new AnthropicHandler(options)
		const pinned = mediateModelHandler(original, context)
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: [{ type: "text", text: "original" }] },
		]
		const metadata = {
			taskId: "task",
			tools: [
				{
					type: "function" as const,
					function: { name: "original", parameters: { type: "object", properties: {} } },
				},
			],
		}
		const stream = pinned.createMessage("system", messages, metadata)
		// Caller mutations before generator iteration must not change the prepared request.
		messages[0].content = "mutated"
		metadata.tools[0].function.name = "mutated"
		const pending = stream.next()
		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
		options.apiModelId = "claude-3-opus-20240229"
		options.apiKey = "replacement"
		options.modelTemperature = 1
		pinned.getModel().info.contextWindow = 1
		grant({ outcome: "granted", settle })
		await pending
		while (!(await stream.next()).done) {
			/* drain usage */
		}
		expect(create.mock.calls[0][0]).toMatchObject({
			model: "claude-sonnet-4-6",
			tools: [expect.objectContaining({ name: "original" })],
		})
		expect(JSON.stringify(create.mock.calls[0][0].messages)).toContain("original")
		expect(JSON.stringify(create.mock.calls[0][0].messages)).not.toContain("mutated")
		expect(construct.mock.calls[1][0].apiKey).toBe("original-key")
		expect(pinned.getModel().info.contextWindow).toBeGreaterThan(1)
	})

	it("uses fresh physical identities for explicit calls within one logical operation", async () => {
		const pinned = handler()
		await collect(pinned)
		await collect(pinned)
		const [first, second] = admit.mock.calls.map(([descriptor]) => descriptor)
		expect(first.operationId).toBe(second.operationId)
		expect(first.dispatchId).not.toBe(second.dispatchId)
		expect(Object.isFrozen(first)).toBe(true)
	})

	it("cancels before admission without calling the runtime", async () => {
		controller.abort()
		await expect(collect(handler())).rejects.toMatchObject({ code: "cancelled" })
		expect(admit).not.toHaveBeenCalled()
		expect(create).not.toHaveBeenCalled()
	})

	it("cancels a pending admission and releases a late grant without dispatch", async () => {
		let grant!: (value: DispatchAdmission) => void
		admit.mockImplementation(
			() =>
				new Promise((resolve) => {
					grant = resolve
				}),
		)
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		const pending = collect(handler())
		await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce())
		controller.abort()
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		grant({ outcome: "granted", settle })
		await vi.waitFor(() => expect(settle).toHaveBeenCalledExactlyOnceWith("not-dispatched"))
		expect(create).not.toHaveBeenCalled()
		expect(remove.mock.calls[0][1]).toBe(add.mock.calls[0][1])
	})

	it.each(["stale", "lease-expired"])("rechecks %s after admission", async (code) => {
		let current = true
		context = { ...context, isCurrent: () => current }
		admit.mockImplementation(async () => {
			if (code === "stale") current = false
			return { outcome: "granted", settle, isValid: () => code !== "lease-expired" }
		})
		await expect(collect(handler())).rejects.toMatchObject({ code })
		expect(create).not.toHaveBeenCalled()
		expect(settle).toHaveBeenCalledExactlyOnceWith("not-dispatched")
	})

	it("aborts a stalled provider stream and reports unresolved exposure", async () => {
		create.mockResolvedValue({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) })
		const pending = collect(handler())
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
		controller.abort()
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		expect(create.mock.calls[0][1].signal.aborted).toBe(true)
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
	})

	it("cancels request acquisition even when the transport ignores its signal", async () => {
		create.mockReturnValue(new Promise(() => {}))
		const pending = collect(handler())
		await vi.waitFor(() => expect(create).toHaveBeenCalledOnce())
		controller.abort()
		await expect(pending).rejects.toMatchObject({ code: "cancelled" })
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
	})

	it("does not retry a completed dispatch if the settlement observer fails", async () => {
		settle.mockImplementation(() => {
			throw new Error("observer unavailable")
		})
		await collect(handler())
		expect(create).toHaveBeenCalledOnce()
		expect(settle).toHaveBeenCalledExactlyOnceWith("completed")
	})

	it("closes an early-returned stream with unresolved exposure", async () => {
		const stream = handler().createMessage("system", [{ role: "user", content: "hello" }])
		await stream.next()
		await stream.return(undefined)
		expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
	})

	it.each(["http-error", "stream-error", "missing-stop"])(
		"reports unresolved for %s without hidden retry",
		async (failure) => {
			if (failure === "http-error") create.mockRejectedValue(new Error("429"))
			else
				create.mockResolvedValue(
					(async function* () {
						yield {
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "partial" },
						}
						if (failure === "stream-error") throw new Error("interrupted")
					})(),
				)
			await expect(collect(handler())).rejects.toMatchObject({ code: "dispatch-failed" })
			expect(create).toHaveBeenCalledOnce()
			expect(settle).toHaveBeenCalledExactlyOnceWith("unresolved")
		},
	)

	it("propagates condensation denial through context management without truncation or history mutation", async () => {
		admit.mockResolvedValue({ outcome: "budget-denied" })
		const apiHandler = handler()
		apiHandler.countTokens = vi.fn(async () => 100)
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "answer" },
			{ role: "user", content: "last" },
		]
		const before = structuredClone(messages)
		await expect(
			summarizeConversation({
				messages,
				apiHandler,
				systemPrompt: "system",
				taskId: "task",
				isAutomaticTrigger: false,
			}),
		).rejects.toMatchObject({ code: "budget-denied" })
		await expect(
			manageContext({
				messages,
				apiHandler,
				systemPrompt: "system",
				taskId: "task",
				totalTokens: 1000,
				contextWindow: 1000,
				maxTokens: 100,
				autoCondenseContext: true,
				contextLimitExceeded: true,
				autoCondenseContextPercent: 50,
				profileThresholds: {},
				currentProfileId: "profile",
			}),
		).rejects.toMatchObject({ code: "budget-denied" })
		expect(messages).toEqual(before)
		expect(create).not.toHaveBeenCalled()
	})
})
