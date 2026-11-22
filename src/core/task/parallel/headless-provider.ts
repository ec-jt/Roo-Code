/**
 * Provider view for a parallel child (ADR-2026-11-22-parallel-subtasks rule 2).
 *
 * A child Task talks to its provider only through `task.providerRef`. Giving it this view keeps the
 * child headless without changing how Task posts UI state:
 * - every webview post (`postStateToWebview*`, `postMessageToWebview`) is a no-op;
 * - history items are still saved, without a webview broadcast (C-5: ordinary items with parentTaskId);
 * - `getState()` reports the child's own mode, so its system prompt and tool validation use that mode,
 *   and turns on `preventFocusDisruption`, so file edits are saved without opening diff editors.
 * Everything else (settings, history lookup, `getCurrentTask`, MCP) is the real provider, unchanged.
 * The view never changes an approval setting.
 */

import type { ClineProvider } from "../../webview/ClineProvider"

const SILENT_METHODS = new Set<PropertyKey>([
	"postStateToWebview",
	"postStateToWebviewWithoutTaskHistory",
	"postStateToWebviewWithoutClineMessages",
	"postMessageToWebview",
])

export function createHeadlessProvider(provider: ClineProvider, options: { mode: string }): ClineProvider {
	const noop = async () => {}
	const getState = async () => {
		const state = await provider.getState()
		return {
			...state,
			mode: options.mode,
			experiments: { ...(state?.experiments ?? {}), preventFocusDisruption: true },
		}
	}
	const updateTaskHistory = (item: Parameters<ClineProvider["updateTaskHistory"]>[0]) =>
		provider.updateTaskHistory(item, { broadcast: false })
	return new Proxy(provider, {
		get(target, property) {
			if (SILENT_METHODS.has(property)) return noop
			if (property === "getState") return getState
			if (property === "updateTaskHistory") return updateTaskHistory
			const value = Reflect.get(target, property, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}
