// Timeout for model-list fetches. Prevents a hung provider endpoint from
// blocking extension/webview initialization indefinitely.
export const MODEL_FETCH_TIMEOUT_MS = 10_000
