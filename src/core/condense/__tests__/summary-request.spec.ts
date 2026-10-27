import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../../api"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { ModelDispatchControl } from "../../../api/dispatch-admission"
import { summarizeConversation } from "../index"

const messages = (): ApiMessage[] => [
	{ role: "user", content: "Keep all decisions and pending work", ts: 1 },
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "file.ts" } }],
		ts: 2,
	},
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "important output" }], ts: 3 },
]
function handler(): ApiHandler {
	return {
		createMessage: vi.fn(async function* () {
			yield { type: "text" as const, text: "Summary" }
		}),
		countTokens: vi.fn().mockResolvedValue(10),
		getModel: () => ({ id: "test", info: { contextWindow: 8192, supportsPromptCache: false } }),
	}
}

it("sends all effective history once, without tools or previous-response chaining", async () => {
	const apiHandler = handler()
	const input = messages()
	const before = structuredClone(input)
	const metadata: ApiHandlerCreateMessageMetadata = {
		taskId: "task",
		mode: "code",
		store: false,
		suppressPreviousResponseId: false,
		tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
		tool_choice: "required",
		parallelToolCalls: true,
		allowedFunctionNames: ["read_file"],
	}
	const result = await summarizeConversation({
		messages: input,
		apiHandler,
		systemPrompt: "system",
		taskId: "task",
		metadata,
		customCondensingPrompt: "Custom instructions",
	})
	expect(result.error).toBeUndefined()
	expect(apiHandler.createMessage).toHaveBeenCalledTimes(1)
	const [, sent, meta] = vi.mocked(apiHandler.createMessage).mock.calls[0]
	expect(JSON.stringify(sent)).toContain("important output")
	expect(JSON.stringify(sent)).toContain("Keep all decisions")
	expect(sent.at(-1)?.content).toBe("Custom instructions")
	expect(meta).toEqual({ taskId: "task", mode: "code", store: false, suppressPreviousResponseId: true })
	expect(metadata.tools).toHaveLength(1)
	expect(input).toEqual(before)
	// Tools are omitted only from the summary request, not the next chat's token estimate.
	expect(apiHandler.countTokens).toHaveBeenCalledWith([{ type: "text", text: JSON.stringify(metadata.tools) }])
})

it.each(["throw", "chunk", "mediated"])("does not retry or alter history on %s overflow", async (kind) => {
	const apiHandler = handler()
	apiHandler.createMessage = vi.fn(async function* () {
		yield { type: "text" as const, text: "Incomplete summary must not be applied" }
		yield { type: "usage" as const, inputTokens: 100, outputTokens: 5, totalCost: 0.02 }
		if (kind === "chunk") yield { type: "error" as const, error: "context_length_exceeded", message: "Too large" }
		else if (kind === "mediated") throw new ModelDispatchControl("context-limit")
		else throw Object.assign(new Error("Too large"), { status: 400, code: "context_length_exceeded" })
	})
	const input = messages()
	const before = structuredClone(input)
	const result = await summarizeConversation({ messages: input, apiHandler, systemPrompt: "system", taskId: "task" })
	expect(result).toMatchObject({ summary: "", cost: 0.02, failureKind: "context-limit" })
	expect(result.error).toContain("No summary was applied")
	expect(result.messages).toBe(input)
	expect(input).toEqual(before)
	expect(apiHandler.createMessage).toHaveBeenCalledTimes(1)
	expect(result.condenseId).toBeUndefined()
	expect(result.errorDetails).toContain("Failure: context-limit")
	expect(result.errorDetails).toContain("Provider-reported input tokens: 100")
	expect(result.errorDetails).toContain("Provider-reported output tokens: 5")
	expect(result.errorDetails).not.toContain("Incomplete summary")
})

it("reports only effective request sizes and safe error fields on overflow", async () => {
	const apiHandler = handler()
	apiHandler.createMessage = vi.fn(async function* () {
		yield { type: "usage" as const, inputTokens: 42, outputTokens: 0 }
		throw Object.assign(new Error("private-token https://private.example"), {
			status: 400,
			code: "context_length_exceeded",
			body: { secret: "private-token" },
			response: { headers: { authorization: "private-token" } },
		})
	})
	const input: ApiMessage[] = [
		{ role: "user", content: "hidden-private-text".repeat(1000), condenseParent: "summary" },
		{ role: "user", content: "current-private-summary", isSummary: true, condenseId: "summary" },
		...messages().slice(1),
	]
	const result = await summarizeConversation({ messages: input, apiHandler, systemPrompt: "system", taskId: "task" })
	expect(result.errorDetails).toContain("HTTP status: 400")
	expect(result.errorDetails).toContain("Error code: context_length_exceeded")
	expect(result.errorDetails).toContain("Stored messages in summary prefix: 4")
	expect(result.errorDetails).toContain("Effective history messages: 3")
	expect(result.errorDetails).toContain("Advertised context window: 8192")
	const [prompt, sent] = vi.mocked(apiHandler.createMessage).mock.calls[0]
	const chars =
		prompt.length +
		sent.reduce(
			(sum, message) =>
				sum +
				(typeof message.content === "string"
					? message.content.length
					: message.content.reduce(
							(total, block) => total + (block.type === "text" ? block.text.length : 0),
							0,
						)),
			0,
		)
	expect(result.errorDetails).toContain(`Total request text characters: ${chars}`)
	expect(result.errorDetails).not.toMatch(
		/private-token|private\.example|hidden-private|current-private|important output|file\.ts|authorization/,
	)
	expect(apiHandler.countTokens).not.toHaveBeenCalled()
})

it("reports empty summaries with unavailable usage rather than invented zero counts", async () => {
	const apiHandler = handler()
	apiHandler.createMessage = vi.fn(async function* () {
		yield { type: "text" as const, text: " " }
	})
	const result = await summarizeConversation({
		messages: messages(),
		apiHandler,
		systemPrompt: "system",
		taskId: "task",
	})
	expect(result.failureKind).toBe("empty-summary")
	expect(result.errorDetails).toContain("Failure: empty-summary")
	expect(result.errorDetails).toContain("Provider-reported input tokens: unavailable")
	expect(result.errorDetails).toContain("Provider-reported output tokens: unavailable")
})

it("does not dispatch an already cancelled summary", async () => {
	const apiHandler = handler()
	const controller = new AbortController()
	controller.abort(new Error("Cancelled"))
	await expect(
		summarizeConversation({
			messages: messages(),
			apiHandler,
			systemPrompt: "system",
			taskId: "task",
			signal: controller.signal,
		}),
	).rejects.toThrow("Cancelled")
	expect(apiHandler.createMessage).not.toHaveBeenCalled()
})

it("does not return a summary cancelled during final token counting", async () => {
	const apiHandler = handler()
	const controller = new AbortController()
	vi.mocked(apiHandler.countTokens).mockImplementation(async () => {
		controller.abort(new Error("Cancelled"))
		return 10
	})
	const input = messages()
	const before = structuredClone(input)
	await expect(
		summarizeConversation({
			messages: input,
			apiHandler,
			systemPrompt: "system",
			taskId: "task",
			signal: controller.signal,
		}),
	).rejects.toThrow("Cancelled")
	expect(input).toEqual(before)
})
