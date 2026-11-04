const byId = (id) => document.getElementById(id)
byId("extension-id").textContent = chrome.runtime.id
async function send(message) {
	byId("pair").disabled = true
	byId("revoke").disabled = true
	try {
		const result = await chrome.runtime.sendMessage(message)
		byId("status").textContent =
			result.error ||
			(result.attached
				? "Attached. Select the tab in Roo before reading it."
				: "Detached. Nothing is paired automatically.")
	} catch {
		byId("status").textContent = "Extension unavailable. Pair again explicitly."
	} finally {
		byId("pair").disabled = false
		byId("revoke").disabled = false
	}
}
byId("pair").addEventListener("click", () => {
	const message = { action: "pair", endpoint: byId("endpoint").value.trim(), secret: byId("secret").value.trim() }
	byId("secret").value = ""
	void send(message)
})
byId("revoke").addEventListener("click", () => {
	byId("secret").value = ""
	void send({ action: "revoke" })
})
void send({ action: "status" })
