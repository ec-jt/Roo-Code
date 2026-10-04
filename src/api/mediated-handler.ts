import type { ApiHandler } from "./index"
import { AnthropicHandler } from "./providers/anthropic"
import { ModelDispatchControl, type ModelDispatchContext } from "./dispatch-admission"

/** Explicit allowlist: metadata ignored by other handlers must not bypass admission. */
export function mediateModelHandler(handler: ApiHandler, context: ModelDispatchContext): ApiHandler {
	if (!(handler instanceof AnthropicHandler)) throw new ModelDispatchControl("unsupported-provider")
	return handler.forMediatedOperation(context)
}
