import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import { type ModelRecord, type ExtensionMessage } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

const getLmStudioModels = async (baseUrl?: string, apiKey?: string) =>
	new Promise<ModelRecord>((resolve, reject) => {
		const requestId = crypto.randomUUID()
		const cleanup = () => {
			window.removeEventListener("message", handler)
		}

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error("LM Studio models request timed out"))
		}, 35000)

		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data

			if (message.type === "lmStudioModels" && message.lmStudioModelsRequestId === requestId) {
				clearTimeout(timeout)
				cleanup()

				if (message.lmStudioModelsError) {
					reject(new Error(message.lmStudioModelsError))
				} else if (message.lmStudioModels) {
					resolve(message.lmStudioModels)
				} else {
					reject(new Error("No LMStudio models in response"))
				}
			}
		}

		window.addEventListener("message", handler)
		vscode.postMessage({
			type: "requestLmStudioModels",
			values: { requestId, baseUrl: baseUrl ?? "", apiKey: apiKey ?? "" },
		})
	})

export const useLmStudioModels = (modelId?: string, baseUrl?: string, apiKey?: string) => {
	// Invalidate on credential changes without putting credentials into query keys.
	const scope = useMemo(() => ({ id: crypto.randomUUID(), baseUrl, apiKey }), [baseUrl, apiKey])
	return useQuery({
		queryKey: ["lmStudioModels", scope.id, modelId],
		queryFn: () => getLmStudioModels(scope.baseUrl, scope.apiKey),
		enabled: !!modelId,
		retry: false,
	})
}
