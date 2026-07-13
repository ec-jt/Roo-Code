import path from "path"
import fs from "fs/promises"
import * as vscode from "vscode"
import { GenerateVideoParams } from "@roo-code/types"
import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { fileExistsAtPath } from "../../utils/fs"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { generateVideoWithVideosApi } from "../../api/providers/utils/video-generation"

export class GenerateVideoTool extends BaseTool<"generate_video"> {
	readonly name = "generate_video" as const

	async execute(params: GenerateVideoParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { prompt, path: relPath, image: inputImagePath } = params
		const { handleError, pushToolResult, askApproval } = callbacks

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const isImageGenerationEnabled = experiments.isEnabled(
			state?.experiments ?? {},
			EXPERIMENT_IDS.IMAGE_GENERATION,
		)

		if (!isImageGenerationEnabled) {
			pushToolResult(
				formatResponse.toolError(
					"Video generation is an experimental feature that must be enabled in settings. Please enable 'Image Generation' in the Experimental Settings section.",
				),
			)
			return
		}

		if (!prompt) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_video")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_video", "prompt"))
			return
		}

		if (!relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("generate_video")
			pushToolResult(await task.sayAndCreateMissingParamError("generate_video", "path"))
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)
		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		let inputImageData: string | undefined
		if (inputImagePath) {
			const inputImageFullPath = path.resolve(task.cwd, inputImagePath)
			const inputImageExists = await fileExistsAtPath(inputImageFullPath)
			if (!inputImageExists) {
				await task.say("error", `Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(`Input image not found: ${getReadablePath(task.cwd, inputImagePath)}`),
				)
				return
			}

			const inputImageAccessAllowed = task.rooIgnoreController?.validateAccess(inputImagePath)
			if (!inputImageAccessAllowed) {
				await task.say("rooignore_error", inputImagePath)
				pushToolResult(formatResponse.rooIgnoreError(inputImagePath))
				return
			}

			try {
				const imageBuffer = await fs.readFile(inputImageFullPath)
				const imageExtension = path.extname(inputImageFullPath).toLowerCase().replace(".", "")
				const supportedFormats = ["png", "jpg", "jpeg", "gif", "webp"]
				if (!supportedFormats.includes(imageExtension)) {
					await task.say(
						"error",
						`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
					)
					task.didToolFailInCurrentTurn = true
					pushToolResult(
						formatResponse.toolError(
							`Unsupported image format: ${imageExtension}. Supported formats: ${supportedFormats.join(", ")}`,
						),
					)
					return
				}

				const mimeType = imageExtension === "jpg" ? "jpeg" : imageExtension
				inputImageData = `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`
			} catch (error) {
				await task.say(
					"error",
					`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
				)
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`Failed to read input image: ${error instanceof Error ? error.message : "Unknown error"}`,
					),
				)
				return
			}
		}

		const liteLlmApiKey = state?.liteLlmImageApiKey || state?.apiConfiguration?.litellmApiKey
		const liteLlmBaseUrl = state?.liteLlmImageBaseUrl || state?.apiConfiguration?.litellmBaseUrl
		const selectedModel = (state as any)?.liteLlmVideoGenerationSelectedModel
		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		if (!liteLlmApiKey) {
			const errorMessage = "LiteLLM API key is required for video generation"
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}
		if (!liteLlmBaseUrl) {
			const errorMessage = "LiteLLM base URL is required for video generation"
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}
		if (!selectedModel) {
			const errorMessage = "No LiteLLM video model selected"
			await task.say("error", errorMessage)
			pushToolResult(formatResponse.toolError(errorMessage))
			return
		}

		const fullPath = path.resolve(task.cwd, relPath)
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)
		const sharedMessageProps = {
			tool: "generateVideo" as const,
			path: getReadablePath(task.cwd, relPath),
			content: prompt,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
		}

		try {
			task.consecutiveMistakeCount = 0
			const approvalMessage = JSON.stringify({
				...sharedMessageProps,
				content: prompt,
				...(inputImagePath && { inputImage: getReadablePath(task.cwd, inputImagePath) }),
			})
			const didApprove = await askApproval("tool", approvalMessage, undefined, isWriteProtected)
			if (!didApprove) {
				return
			}

			const result = await generateVideoWithVideosApi({
				baseURL: liteLlmBaseUrl,
				authToken: liteLlmApiKey,
				model: selectedModel,
				prompt,
				inputImage: inputImageData,
			})

			if (!result.success) {
				await task.say("error", result.error || "Failed to generate video")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(result.error || "Failed to generate video"))
				return
			}

			if (!result.videoData) {
				const errorMessage = "No video data received"
				await task.say("error", errorMessage)
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError(errorMessage))
				return
			}

			let finalPath = relPath
			if (!finalPath.match(/\.(mp4|mov|webm)$/i)) {
				finalPath = `${finalPath}.mp4`
			}

			const absolutePath = path.resolve(task.cwd, finalPath)
			const directory = path.dirname(absolutePath)
			await fs.mkdir(directory, { recursive: true })
			await fs.writeFile(absolutePath, Buffer.from(result.videoData))

			if (finalPath) {
				await task.fileContextTracker.trackFileContext(finalPath, "roo_edited")
			}

			task.didEditFile = true
			task.recordToolUsage("generate_video")

			const fullVideoPath = path.join(task.cwd, finalPath)
			const videoUri = provider?.convertToWebviewUri?.(fullVideoPath) ?? vscode.Uri.file(fullVideoPath).toString()
			await task.say("text", `Video saved to ${getReadablePath(task.cwd, finalPath)}\n${videoUri}`)
			pushToolResult(formatResponse.toolResult(getReadablePath(task.cwd, finalPath)))
		} catch (error) {
			await handleError("generating video", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"generate_video">): Promise<void> {
		return
	}
}

export const generateVideoTool = new GenerateVideoTool()
