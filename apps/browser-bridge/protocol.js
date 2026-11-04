// This module is shared by the worker and focused tests. It accepts no raw CDP methods.
export function exact(value, keys) {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key))
	)
}
export function uuid(value) {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	)
}
export function safeUrl(value) {
	const url = new URL(value)
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) tabs are supported.")
	url.username = ""
	url.password = ""
	url.search = ""
	url.hash = ""
	return url.toString().slice(0, 2000)
}
export function pairing(value) {
	if (
		!exact(value, ["action", "endpoint", "secret"]) ||
		value.action !== "pair" ||
		typeof value.endpoint !== "string" ||
		!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(value.endpoint) ||
		typeof value.secret !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.secret)
	)
		throw new Error("Invalid pairing input.")
	const url = new URL(value.endpoint)
	if (Number(url.port) < 1 || Number(url.port) > 65535) throw new Error("Invalid port.")
	return value
}
export function commandMessage(value) {
	if (exact(value, []) && Object.keys(value).length === 0) return null
	if (!exact(value, ["requestId", "documentId", "command"]) || !uuid(value.requestId) || !uuid(value.documentId))
		throw new Error("Invalid command envelope.")
	const command = value.command
	const common = ["action", "sessionId", "tabId", "timeoutMs"]
	const extra = { snapshot: ["limit"], inspect: ["ref"], wait: ["durationMs"] }
	if (
		!command ||
		!Object.hasOwn(extra, command.action) ||
		!exact(command, [...common, ...extra[command.action]]) ||
		!uuid(command.sessionId) ||
		!uuid(command.tabId) ||
		(command.timeoutMs !== undefined &&
			(!Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 15000))
	)
		throw new Error("Unsupported command.")
	if (
		command.action === "snapshot" &&
		command.limit !== undefined &&
		(!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 100)
	)
		throw new Error("Invalid limit.")
	if (command.action === "inspect" && !uuid(command.ref)) throw new Error("Invalid reference.")
	if (
		command.action === "wait" &&
		(!Number.isInteger(command.durationMs) || command.durationMs < 0 || command.durationMs > 5000)
	)
		throw new Error("Invalid duration.")
	return value
}

export function nodeMetadata(node) {
	const attributes = new Map()
	for (let index = 0; index < Math.min(node.attributes?.length ?? 0, 400); index += 2) {
		attributes.set(node.attributes[index], node.attributes[index + 1])
	}
	const text = (value, limit) =>
		typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : ""
	return {
		tag: text(node.localName, 80),
		role: text(attributes.get("role"), 80),
		name: text(attributes.get("aria-label") || attributes.get("title") || attributes.get("alt"), 256),
		type: text(attributes.get("type"), 80),
	}
}
