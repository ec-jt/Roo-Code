import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ExtensionMessage, ModelRecord } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

type DiscoveryState = {
	status: "idle" | "loading" | "success" | "error"
	models: ModelRecord
	error?: string
}
const EMPTY: DiscoveryState = { status: "idle", models: {} }

/** Form-local results only. No query cache, persistence, or shared in-flight requests. */
export function useLiteLLMModels(enabled: boolean, baseUrl = "", apiKey = "") {
	const scope = useMemo(() => ({ enabled, baseUrl, apiKey }), [enabled, baseUrl, apiKey])
	const [result, setResult] = useState<{ scope: typeof scope; state: DiscoveryState }>()
	const cancelRequest = useRef<(() => void) | undefined>()
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>()

	const refresh = useCallback(() => {
		clearTimeout(debounce.current)
		cancelRequest.current?.()
		if (!scope.enabled) return
		if (!scope.baseUrl.trim() || !scope.apiKey) {
			setResult({
				scope,
				state: { status: "error", models: {}, error: "Enter the LiteLLM base URL and API key." },
			})
			return
		}
		const requestId = crypto.randomUUID()
		setResult({ scope, state: { status: "loading", models: {} } })
		const cleanup = () => {
			clearTimeout(timeout)
			window.removeEventListener("message", onMessage)
		}
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type !== "liteLLMModels" || message.requestId !== requestId) return
			cleanup()
			setResult({
				scope,
				state: message.error
					? { status: "error", models: {}, error: message.error }
					: { status: "success", models: message.liteLLMModels ?? {} },
			})
		}
		const timeout = setTimeout(() => {
			cleanup()
			setResult({
				scope,
				state: {
					status: "error",
					models: {},
					error: "LiteLLM model discovery timed out. Try Refresh models again.",
				},
			})
		}, 10000)
		cancelRequest.current = cleanup
		window.addEventListener("message", onMessage)
		vscode.postMessage({
			type: "requestLiteLLMModels",
			requestId,
			values: { baseUrl: scope.baseUrl, apiKey: scope.apiKey },
		})
	}, [scope])

	useEffect(() => {
		setResult(undefined)
		if (enabled && baseUrl.trim() && apiKey) debounce.current = setTimeout(refresh, 300)
		return () => {
			clearTimeout(debounce.current)
			cancelRequest.current?.()
		}
	}, [enabled, baseUrl, apiKey, refresh])

	return { ...(result?.scope === scope ? result.state : EMPTY), refresh }
}
