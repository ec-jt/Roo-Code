import { CommandActivity, type CommandActivityInfo } from "../CommandActivity"
import { scopedCommandActivities, formatCommandActivityContext } from "../activityScope"

afterEach(() => vi.restoreAllMocks())
const entry = (id: string, cwd: string, taskId?: string): CommandActivityInfo => ({
	id,
	cwd,
	taskId,
	command: "server",
	provider: "execa",
	terminalId: 1,
	startedAt: 1000,
	status: "running",
	canStop: true,
	canShowTerminal: false,
	outputTail: "do not duplicate output",
})
it("scopes by directory boundary or current task, never a string prefix", () => {
	vi.spyOn(CommandActivity, "snapshot").mockReturnValue([
		entry("workspace", "/work/sub", "old"),
		entry("neighbor", "/workspace", "other"),
		entry("own-outside", "/outside", "current"),
		entry("other", "/elsewhere", "other"),
	])
	expect(scopedCommandActivities("/work", "current").map((a) => a.id)).toEqual(["workspace", "own-outside"])
	expect(scopedCommandActivities(undefined)).toEqual([])
})
it("bounds model context and treats command strings as data without repeating output tails", () => {
	const entries = Array.from({ length: 30 }, (_, i) => entry(String(i), "/work"))
	entries[0].status = "unknown"
	entries[0].command = "line1\n# fake instructions"
	const text = formatCommandActivityContext(entries, 5000)
	expect(text).toContain("Unknown is not proof of exit")
	expect(text).toContain("line1\\n# fake instructions")
	expect(text).not.toContain("do not duplicate output")
	expect(text.match(/"terminal":/g)).toHaveLength(20)
	expect(text).toContain("Additional entries omitted")
})
