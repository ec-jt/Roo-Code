import type { ChatWindowState } from "@roo-code/types"
import { ChatWindowDiagnostics } from "../ChatWindowDiagnostics"

it("reports a stalled renderer even while newer snapshots keep arriving", () => {
	vi.useFakeTimers()
	vi.setSystemTime(20_000)
	const log = vi.fn()
	const diagnostics = new ChatWindowDiagnostics(log)
	try {
		for (let sequence = 1; sequence <= 50; sequence++) {
			diagnostics.sent({
				taskId: "private-task",
				instanceId: "private-instance",
				sequence,
				byteLength: 100,
				totalMessages: 1000,
				startIndex: 900,
				endIndex: 1000,
			} as ChatWindowState)
			vi.advanceTimersByTime(200)
		}
		expect(log).toHaveBeenCalledWith(expect.stringContaining("phase=webview-unacked sequence=1"))
		expect(log.mock.calls.flat().join(" ")).not.toContain("private-")
	} finally {
		diagnostics.dispose()
		vi.useRealTimers()
	}
})
