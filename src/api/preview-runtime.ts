import type { Experiments } from "@roo-code/types"

import { isCordisRuntimePreviewEnabled } from "../shared/experiments"

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
	// The dispatch runtime stays Anthropic-only (R-5); the Cordis profile itself is provider-independent.
	return provider === "anthropic" && isCordisRuntimePreviewEnabled(experiments) ? previewRuntime : undefined
}
