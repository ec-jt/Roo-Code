import { presentAssistantMessage } from "../presentAssistantMessage"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { fileSystemTool } from "../../tools/FileSystemTool"
import { NativeToolCallParser } from "../NativeToolCallParser"

vi.mock("../../task/Task")
vi.mock("../../tools/FileSystemTool", () => ({ fileSystemTool: { handle: vi.fn() } }))

describe("presentAssistantMessage malformed tool calls", () => {
	let task: any
	const malformed = (id: string) =>
		NativeToolCallParser.parseToolCallOrError({
			id,
			name: "file_system",
			arguments: '{"action":"invalid","path":"."}',
		})
	beforeEach(() => {
		vi.clearAllMocks()
		task = {
			taskId: "task",
			instanceId: "instance",
			abort: false,
			presentAssistantMessageLocked: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [malformed("call")],
			assistantMessageSavedToHistory: true,
			checkToolInvocation: vi.fn().mockResolvedValue({ allow: true }),
			admitModelOperationTool: vi.fn().mockResolvedValue(true),
			userMessageContent: [],
			didCompleteReadingStream: true,
			didRejectTool: false,
			didAlreadyUseTool: false,
			didToolFailInCurrentTurn: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: { getModel: () => ({ info: {} }) },
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			toolRepetitionDetector: new ToolRepetitionDetector(3),
			providerRef: { deref: () => ({ getState: async () => ({ mode: "code" }) }) },
			say: vi.fn(),
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "Use a supported action." }),
			pushToolResultToUserContent: vi.fn((result) => task.userMessageContent.push(result)),
		}
	})

	it.each([undefined, { action: "list_directory", path: "." }])(
		"rejects explicit errors even with nativeArgs %j",
		async (nativeArgs) => {
			task.assistantMessageContent[0].nativeArgs = nativeArgs
			await presentAssistantMessage(task)
			await presentAssistantMessage(task)
			expect(task.userMessageContent).toHaveLength(1)
			expect(task.userMessageContent[0]).toMatchObject({
				type: "tool_result",
				tool_use_id: "call",
				is_error: true,
				content: expect.stringContaining("resend one complete JSON object"),
			})
			expect(task.consecutiveMistakeCount).toBe(1)
			expect(task.recordToolError).toHaveBeenCalledTimes(1)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.didAlreadyUseTool).toBe(false)
			expect(task.admitModelOperationTool).not.toHaveBeenCalled()
			expect(task.ask).not.toHaveBeenCalled()
			expect(fileSystemTool.handle).not.toHaveBeenCalled()
		},
	)

	it("still returns one structured result when recording diagnostics fails", async () => {
		task.recordToolError.mockImplementation(() => {
			throw new Error("diagnostics unavailable")
		})
		await presentAssistantMessage(task)
		expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(1)
		expect(task.userMessageContent[0]).toMatchObject({ is_error: true })
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(fileSystemTool.handle).not.toHaveBeenCalled()
	})

	it("counts missing nativeArgs as a failure and checks repetition", async () => {
		delete task.assistantMessageContent[0].argumentError
		const check = vi.spyOn(task.toolRepetitionDetector, "check")
		await presentAssistantMessage(task)
		expect(check).toHaveBeenCalledTimes(1)
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(fileSystemTool.handle).not.toHaveBeenCalled()
	})

	it.each([1, 3, 5])(
		"pauses at configured repetition limit %s and emits one result per failed call",
		async (limit) => {
			task.toolRepetitionDetector = new ToolRepetitionDetector(limit)
			task.assistantMessageContent = Array.from({ length: limit + 1 }, (_, index) => malformed(`call${index}`))
			let resume!: (value: unknown) => void
			task.ask.mockImplementation(
				() =>
					new Promise((resolve) => {
						resume = resolve
					}),
			)
			const presenting = presentAssistantMessage(task)
			await vi.waitFor(() => expect(task.ask).toHaveBeenCalledTimes(1))
			expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(limit)
			expect(task.presentAssistantMessageLocked).toBe(true)
			resume({ response: "messageResponse", text: "Use a supported action." })
			await presenting
			await vi.waitFor(() => expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(limit + 1))
			expect(task.recordToolError).toHaveBeenCalledTimes(limit + 1)
			expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(limit + 1)
			expect(task.userMessageContent.filter((block: any) => block.type === "tool_result")).toHaveLength(limit + 1)
			expect(task.userMessageContent.at(-1)).toMatchObject({
				is_error: true,
				content: expect.stringContaining("Tool call repetition limit reached"),
			})
			expect(task.consecutiveMistakeCount).toBe(0)
			expect(task.didToolFailInCurrentTurn).toBe(true)
			expect(task.say).toHaveBeenCalledWith("user_feedback", "Use a supported action.", undefined)
			expect(fileSystemTool.handle).not.toHaveBeenCalled()
		},
	)

	it("preserves 0 as unlimited while rejecting every malformed call", async () => {
		task.toolRepetitionDetector = new ToolRepetitionDetector(0)
		task.assistantMessageContent = Array.from({ length: 8 }, (_, index) => malformed(`call${index}`))
		await presentAssistantMessage(task)
		await vi.waitFor(() => expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(8))
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(8)
		expect(task.pushToolResultToUserContent).toHaveBeenCalledTimes(8)
		expect(fileSystemTool.handle).not.toHaveBeenCalled()
	})
})
