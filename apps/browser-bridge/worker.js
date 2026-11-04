import { exact, pairing, commandMessage, safeUrl, nodeMetadata } from "./protocol.js"

// No storage API, content scripts, externally_connectable, automatic pairing, or retry path.
let active
let changing = false
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function rpc(state, path, payload) {
	const response = await fetch(`${state.endpoint}${path}`, {
		method: "POST",
		mode: "cors",
		credentials: "omit",
		cache: "no-store",
		redirect: "error",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${state.secret}` },
		body: JSON.stringify({ clientId: state.clientId, sequence: ++state.sequence, ...payload }),
		signal: AbortSignal.timeout(4000),
	})
	if (!response.ok) throw new Error("Bridge disconnected. Pair again explicitly.")
	const reader = response.body.getReader()
	const parts = []
	let size = 0
	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		size += value.length
		if (size > 16_384) {
			await reader.cancel()
			throw new Error("Oversized bridge message.")
		}
		parts.push(value)
	}
	const bytes = new Uint8Array(size)
	let offset = 0
	for (const part of parts) {
		bytes.set(part, offset)
		offset += part.length
	}
	return JSON.parse(new TextDecoder().decode(bytes))
}

async function revoke(state = active) {
	if (!state || state.revoked) return
	state.revoked = true
	if (active === state) active = undefined
	state.refs.clear()
	state.secret = ""
	// Losing the polling connection revokes the server within ten seconds. Do not race sequence numbers.
	await chrome.debugger.detach({ tabId: state.tabId }).catch(() => {})
}

async function current(state, documentId) {
	if (active !== state || state.documentId !== documentId) throw new Error("stale_reference")
	const tab = await chrome.tabs.get(state.tabId)
	state.url = safeUrl(tab.url)
	if (active !== state || state.documentId !== documentId) throw new Error("stale_reference")
}

async function cdp(state, method, params = {}) {
	let timer
	const result = await Promise.race([
		chrome.debugger.sendCommand({ tabId: state.tabId }, method, params),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("CDP timeout")), 3000)
		}),
	]).finally(() => clearTimeout(timer))
	// Bound retained data and traversal. Never send protocol errors or raw nodes to Roo.
	if (JSON.stringify(result).length > 256_000) throw new Error("DOM result too large.")
	return result
}

async function execute(state, message) {
	const { command, documentId } = message
	if (command.tabId !== state.opaqueTabId) throw new Error("stale_reference")
	if (state.sessionId && state.sessionId !== command.sessionId) throw new Error("stale_reference")
	state.sessionId = command.sessionId
	await current(state, documentId)
	let data = {}
	if (command.action === "wait") await sleep(command.durationMs)
	if (command.action === "snapshot") {
		state.refs.clear()
		const { root } = await cdp(state, "DOM.getDocument", { depth: 1, pierce: false })
		const queue = [...(root.children ?? [])]
		const elements = []
		let visited = 0
		while (queue.length && elements.length < (command.limit ?? 50) && visited++ < 200) {
			await current(state, documentId)
			const node = queue.shift()
			if (node.nodeType !== 1) continue
			const metadata = nodeMetadata(node)
			if (!["script", "style", "noscript"].includes(metadata.tag)) {
				const ref = crypto.randomUUID()
				state.refs.set(ref, { backendNodeId: node.backendNodeId, documentId })
				elements.push({ ref, ...metadata })
				if (node.childNodeCount && queue.length < 200) {
					const { node: expanded } = await cdp(state, "DOM.describeNode", {
						backendNodeId: node.backendNodeId,
						depth: 1,
						pierce: false,
					})
					queue.push(...(expanded.children ?? []).slice(0, 200 - queue.length))
				}
			}
		}
		data = { elements, truncated: queue.length > 0 || visited >= 200 }
	}
	if (command.action === "inspect") {
		const ref = state.refs.get(command.ref)
		if (!ref || ref.documentId !== documentId) throw new Error("stale_reference")
		const { node } = await cdp(state, "DOM.describeNode", {
			backendNodeId: ref.backendNodeId,
			depth: 0,
			pierce: false,
		})
		data = { inspection: { ...nodeMetadata(node), connected: true } }
	}
	await current(state, documentId)
	return data
}

async function poll(state) {
	try {
		while (active === state) {
			await current(state, state.documentId)
			const message = commandMessage(await rpc(state, "/poll", { documentId: state.documentId, url: state.url }))
			if (message) {
				if (state.seen.has(message.requestId) || state.seen.size >= 1000)
					throw new Error("Repeated command or session limit.")
				state.seen.add(message.requestId)
				let result
				let commandTimer
				try {
					const data = await Promise.race([
						execute(state, message),
						new Promise((_, reject) => {
							commandTimer = setTimeout(() => {
								void revoke(state)
								reject(new Error("Command timeout"))
							}, message.command.timeoutMs ?? 8000)
						}),
					])
					result = { ok: true, data }
				} catch (error) {
					result = {
						ok: false,
						error: error.message === "stale_reference" ? "stale_reference" : "operation_failed",
					}
				} finally {
					clearTimeout(commandTimer)
				}
				if (active !== state) break
				const ack = await rpc(state, "/result", {
					requestId: message.requestId,
					documentId: state.documentId,
					url: state.url,
					...result,
				})
				if (!exact(ack, []) || Object.keys(ack).length) throw new Error("Invalid acknowledgement.")
			}
			await sleep(250)
		}
	} catch {
		await revoke(state)
	}
}

async function pairActive(message) {
	const input = pairing(message)
	if (active) throw new Error("Revoke the current attachment before pairing again.")
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
	if (!tab || !Number.isInteger(tab.id)) throw new Error("No active tab.")
	const url = safeUrl(tab.url)
	const state = {
		endpoint: input.endpoint,
		secret: input.secret,
		clientId: crypto.randomUUID(),
		sequence: 0,
		tabId: tab.id,
		opaqueTabId: crypto.randomUUID(),
		documentId: crypto.randomUUID(),
		url,
		refs: new Map(),
		seen: new Set(),
	}
	await chrome.debugger.attach({ tabId: tab.id }, "1.3")
	active = state
	try {
		await cdp(state, "Page.enable")
		await cdp(state, "DOM.enable")
		await current(state, state.documentId)
		const ack = await rpc(state, "/pair", {
			tabId: state.opaqueTabId,
			documentId: state.documentId,
			url: state.url,
		})
		if (!exact(ack, []) || Object.keys(ack).length) throw new Error("Invalid acknowledgement.")
		void poll(state)
	} catch {
		await revoke(state)
		throw new Error("Pairing failed. Start a new native bridge and pair explicitly.")
	}
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
	// Only this extension's popup can initiate pairing. No tabs or external senders.
	if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html") || sender.tab)
		return false
	if (exact(message, ["action"]) && message.action === "status") {
		respond({ attached: !!active })
		return false
	}
	if (changing) {
		respond({ error: "Another action is pending." })
		return false
	}
	changing = true
	void (async () => {
		try {
			if (message?.action === "pair") await pairActive(message)
			else if (exact(message, ["action"]) && message.action === "revoke") await revoke()
			else throw new Error("Unsupported popup action.")
			respond({ attached: !!active })
		} catch {
			respond({ error: "Could not pair or attach. Check the native pairing dialog and active HTTP(S) tab." })
		} finally {
			changing = false
		}
	})()
	return true
})

chrome.debugger.onDetach.addListener((source) => {
	if (active?.tabId === source.tabId) void revoke()
})
chrome.debugger.onEvent.addListener((source, method, params) => {
	const state = active
	if (!state || source.tabId !== state.tabId) return
	if (method === "DOM.documentUpdated" || (method === "Page.frameNavigated" && !params.frame.parentId)) {
		state.documentId = crypto.randomUUID()
		state.refs.clear()
	}
	if (method === "Page.frameNavigated" && !params.frame.parentId) {
		try {
			state.url = safeUrl(params.frame.url)
		} catch {
			void revoke(state)
		}
	}
})
chrome.tabs.onUpdated.addListener((tabId, change) => {
	if (active?.tabId === tabId && change.url) {
		try {
			active.url = safeUrl(change.url)
			active.documentId = crypto.randomUUID()
			active.refs.clear()
		} catch {
			void revoke()
		}
	}
})
// Chrome 118+ keeps an attached debugger worker alive. Best-effort detach on teardown;
// no persisted credentials or automatic restoration exists after a restart.
chrome.runtime.onSuspend.addListener(() => {
	void revoke()
})
