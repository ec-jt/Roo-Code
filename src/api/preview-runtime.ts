import type { Experiments } from "@roo-code/types"

import type { ModelDispatchRuntime } from "./dispatch-admission"

/** Transport admission preview only: no graph scheduler, ledger, or financial caps. */
const previewRuntime: ModelDispatchRuntime = {
	async admit() {
		return { outcome: "granted", settle: () => {} }
	},
}

export function selectPreviewRuntime(
	provider: string | undefined,
	experiments: Experiments | undefined,
): ModelDispatchRuntime | undefined {
	return provider === "anthropic" && experiments?.cordisRuntimePreview === true ? previewRuntime : undefined
}
