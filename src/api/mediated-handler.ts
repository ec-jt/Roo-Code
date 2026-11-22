import type { ApiHandler } from "./index"
import { AnthropicHandler } from "./providers/anthropic"
import {
	ModelDispatchControl,
	abortable,
	admitDispatch,
	checkDispatch,
	type ModelDispatchContext,
} from "./dispatch-admission"
import { checkContextWindowExceededError } from "../core/context/context-management/context-error-handling"

/**
 * Explicit allowlist: metadata ignored by other handlers must not bypass admission.
 * The preview runtime (no `providerScope`, or "anthropic") mediates Anthropic only (R-5).
 * A runtime with `providerScope: "any"` (parallel subtasks) mediates every provider handler.
 */
export function mediateModelHandler(handler: ApiHandler, context: ModelDispatchContext): ApiHandler {
	if (context.runtime.providerScope === "any") return mediateAnyHandler(handler, context)
	if (!(handler instanceof AnthropicHandler)) throw new ModelDispatchControl("unsupported-provider")
	return handler.forMediatedOperation(context)
}

/** Provider failure to a typed dispatch stop, like the Anthropic mediated path. */
function dispatchFailure(error: unknown): ModelDispatchControl {
	if (error instanceof ModelDispatchControl) return error
	return new ModelDispatchControl(checkContextWindowExceededError(error) ? "context-limit" : "dispatch-failed", {
		cause: error,
	})
}

/**
 * Provider-independent mediation. The resolved model is pinned before any admission wait.
 * Admission happens once per `createMessage`, before the provider is called. The grant is settled
 * when the stream ends. Reported usage is passed to the runtime before settlement.
 * Only message streaming and token counting are exposed, not completePrompt.
 */
function mediateAnyHandler(handler: ApiHandler, context: ModelDispatchContext): ApiHandler {
	const model = structuredClone(handler.getModel())
	const maxOutputTokens = (model as { maxTokens?: number }).maxTokens ?? model.info.maxTokens ?? 0
	return {
		getModel: () => structuredClone(model),
		countTokens: (content) => handler.countTokens(content),
		createMessage: (systemPrompt, messages, metadata) =>
			(async function* () {
				const { settle, checkLease } = await admitDispatch(context, model.id, maxOutputTokens)
				let completed = false
				let iterator: AsyncIterator<any> | undefined
				try {
					checkDispatch(context)
					checkLease()
					iterator = handler.createMessage(systemPrompt, messages, metadata)[Symbol.asyncIterator]()
					while (true) {
						checkDispatch(context)
						const next = await abortable(iterator.next(), context.signal)
						checkDispatch(context)
						if (next.done) break
						if (next.value?.type === "usage") {
							try {
								context.runtime.recordUsage?.({
									inputTokens: next.value.inputTokens ?? 0,
									outputTokens: next.value.outputTokens ?? 0,
								})
							} catch {
								// A runtime observer failure never fails a dispatched request.
							}
						}
						yield next.value
					}
					completed = true
				} catch (error) {
					throw dispatchFailure(error)
				} finally {
					settle(iterator ? (completed ? "completed" : "unresolved") : "not-dispatched")
					void Promise.resolve(iterator?.return?.(undefined)).catch(() => {})
				}
			})(),
	}
}
