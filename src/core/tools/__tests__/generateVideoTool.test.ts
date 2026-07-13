import { describe, it, expect, vi, beforeEach } from "vitest"
import { generateVideoTool } from "../GenerateVideoTool"
import { ToolUse } from "../../../shared/tools"
import { Task } from "../../task/Task"
import * as fs from "fs/promises"
import * as pathUtils from "../../../utils/pathUtils"
import * as fileUtils from "../../../utils/fs"
import { EXPERIMENT_IDS } from "../../../shared/experiments"
import * as videoGenerationUtils from "../../../api/providers/utils/video-generation"

vi.mock("fs/promises")
vi.mock("../../../utils/pathUtils")
vi.mock("../../../utils/fs")
vi.mock("../../../api/providers/utils/video-generation")

describe("generateVideoTool", () => {
	let mockCline: any
	let mockAskApproval: any
	let mockHandleError: any
	let mockPushToolResult: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockCline = {
			cwd: "/test/workspace",
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			recordToolUsage: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			say: vi.fn(),
			rooIgnoreController: {
				validateAccess: vi.fn().mockReturnValue(true),
			},
			rooProtectedController: {
				isWriteProtected: vi.fn().mockReturnValue(false),
			},
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({
						experiments: {
							[EXPERIMENT_IDS.IMAGE_GENERATION]: true,
						},
						liteLlmImageApiKey: "litellm-video-key",
						liteLlmImageBaseUrl: "http://localhost:4000",
						liteLlmVideoGenerationSelectedModel: "video/demo-model",
						apiConfiguration: {
							litellmBaseUrl: "http://localhost:4000",
							litellmApiKey: "provider-litellm-key",
						},
					}),
					convertToWebviewUri: vi
						.fn()
						.mockReturnValue("https://file+.vscode-resource.vscode-cdn.net/test/workspace/test-video.mp4"),
				}),
			},
			fileContextTracker: {
				trackFileContext: vi.fn(),
			},
			didEditFile: false,
		}

		mockAskApproval = vi.fn().mockResolvedValue(true)
		mockHandleError = vi.fn()
		mockPushToolResult = vi.fn()

		vi.mocked(fileUtils.fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("fake-image-data"))
		vi.mocked(fs.mkdir).mockResolvedValue(undefined)
		vi.mocked(fs.writeFile).mockResolvedValue(undefined)
		vi.mocked(pathUtils.isPathOutsideWorkspace).mockReturnValue(false)
		vi.mocked(videoGenerationUtils.generateVideoWithVideosApi).mockResolvedValue({
			success: true,
			videoData: new Uint8Array([1, 2, 3]),
			videoFormat: "mp4",
		})
	})

	it("should route LiteLLM video generation through the videos API helper", async () => {
		const completeBlock: ToolUse = {
			type: "tool_use",
			name: "generate_video",
			params: {
				prompt: "Generate a LiteLLM video",
				path: "litellm-video.mp4",
			},
			nativeArgs: {
				prompt: "Generate a LiteLLM video",
				path: "litellm-video.mp4",
			},
			partial: false,
		}

		await generateVideoTool.handle(mockCline as Task, completeBlock as ToolUse<"generate_video">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(videoGenerationUtils.generateVideoWithVideosApi).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "http://localhost:4000",
				authToken: "litellm-video-key",
				model: "video/demo-model",
				prompt: "Generate a LiteLLM video",
			}),
		)
	})

	it("should pass image input as input_reference for video generation", async () => {
		const completeBlock: ToolUse = {
			type: "tool_use",
			name: "generate_video",
			params: {
				prompt: "Animate this image",
				path: "litellm-video.mp4",
				image: "images/source.png",
			},
			nativeArgs: {
				prompt: "Animate this image",
				path: "litellm-video.mp4",
				image: "images/source.png",
			},
			partial: false,
		}

		await generateVideoTool.handle(mockCline as Task, completeBlock as ToolUse<"generate_video">, {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(videoGenerationUtils.generateVideoWithVideosApi).toHaveBeenCalledWith(
			expect.objectContaining({
				inputImage: expect.stringMatching(/^data:image\/png;base64,/),
			}),
		)
	})
})
