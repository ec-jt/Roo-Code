import { presentAssistantMessage } from "../presentAssistantMessage"
import { NativeToolCallParser } from "../NativeToolCallParser"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { extractTextFromFile } from "../../../integrations/misc/extract-text"

vi.mock("../../task/Task")
vi.mock("../../../integrations/misc/extract-text", () => ({ extractTextFromFile: vi.fn() }))
vi.mock("../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: () => false }))

describe("read-only tool failure continuation", () => {
	it.each(["file_system", "markdownify"] as const)("completes %s after a file read fails", async (name) => {
		vi.mocked(extractTextFromFile).mockRejectedValueOnce(new Error("file read failed"))
		const task: any = {
			cwd: "/workspace",
			taskId: "task",
			instanceId: "instance",
			abort: false,
			presentAssistantMessageLocked: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [
				NativeToolCallParser.parseToolCallOrError({
					id: "call",
					name,
					arguments: JSON.stringify({
						path: "missing.txt",
						...(name === "file_system" ? { action: "read_text_file" } : {}),
					}),
				}),
			],
			assistantMessageSavedToHistory: true,
			checkToolInvocation: vi.fn().mockResolvedValue({ allow: true }),
			admitModelOperationTool: vi.fn().mockResolvedValue(true),
			userMessageContent: [],
			didCompleteReadingStream: true,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: { getModel: () => ({ info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: new ToolRepetitionDetector(3),
			providerRef: { deref: () => ({ getState: async () => ({ mode: "code" }) }) },
			rooIgnoreController: { validateAccess: () => true },
			say: vi.fn(),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn((result) => task.userMessageContent.push(result)),
		}
		await presentAssistantMessage(task)
		expect(task.pushToolResultToUserContent).toHaveBeenCalledOnce()
		expect(task.userMessageContent[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "call",
			content: expect.stringContaining("file read failed"),
		})
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
		expect(task.userMessageContentReady).toBe(true)
		expect(task.currentStreamingContentIndex).toBe(1)
	})
})
