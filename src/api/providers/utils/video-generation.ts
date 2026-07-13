import { t } from "../../../i18n"

export interface VideoGenerationResult {
	success: boolean
	videoData?: Uint8Array
	videoFormat?: string
	error?: string
}

interface VideoGenerationResponse {
	id?: string
	status?: string
	error?: {
		message?: string
		type?: string
		code?: string
	}
	progress?: number
}

interface VideoGenerationOptions {
	baseURL: string
	authToken: string
	model: string
	prompt: string
	inputImage?: string
	seconds?: string
	size?: string
	pollIntervalMs?: number
	maxPollAttempts?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function getVideosBaseUrl(baseURL: string): string {
	const normalized = baseURL.replace(/\/$/, "")
	return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`
}

function getHeaders(authToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${authToken}`,
		"x-litellm-api-key": authToken,
		"Content-Type": "application/json",
	}
}

export async function generateVideoWithVideosApi(options: VideoGenerationOptions): Promise<VideoGenerationResult> {
	const {
		baseURL,
		authToken,
		model,
		prompt,
		inputImage,
		seconds,
		size,
		pollIntervalMs = 2_000,
		maxPollAttempts = 60,
	} = options

	try {
		const videosBaseUrl = getVideosBaseUrl(baseURL)
		const createResponse = await fetch(`${videosBaseUrl}/videos`, {
			method: "POST",
			headers: getHeaders(authToken),
			body: JSON.stringify({
				model,
				prompt,
				...(seconds ? { seconds } : {}),
				...(size ? { size } : {}),
				...(inputImage ? { input_reference: inputImage } : {}),
			}),
		})

		if (!createResponse.ok) {
			const errorText = await createResponse.text()
			let errorMessage = t("tools:generateImage.failedWithStatus", {
				status: createResponse.status,
				statusText: createResponse.statusText,
			})

			try {
				const errorJson = JSON.parse(errorText)
				if (errorJson.error?.message) {
					errorMessage = t("tools:generateImage.failedWithMessage", {
						message: errorJson.error.message,
					})
				}
			} catch {
				// Use default error message
			}

			return { success: false, error: errorMessage }
		}

		const created: VideoGenerationResponse = await createResponse.json()
		if (created.error?.message) {
			return {
				success: false,
				error: t("tools:generateImage.failedWithMessage", { message: created.error.message }),
			}
		}

		if (!created.id) {
			return { success: false, error: "Video generation did not return a video ID" }
		}

		for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
			const statusResponse = await fetch(`${videosBaseUrl}/videos/${created.id}`, {
				method: "GET",
				headers: getHeaders(authToken),
			})

			if (!statusResponse.ok) {
				const errorText = await statusResponse.text()
				return {
					success: false,
					error: `Video status request failed: ${statusResponse.status} ${statusResponse.statusText}${
						errorText ? ` - ${errorText}` : ""
					}`,
				}
			}

			const status: VideoGenerationResponse = await statusResponse.json()
			if (status.error?.message) {
				return {
					success: false,
					error: t("tools:generateImage.failedWithMessage", { message: status.error.message }),
				}
			}

			if (status.status === "completed") {
				const contentResponse = await fetch(`${videosBaseUrl}/videos/${created.id}/content`, {
					method: "GET",
					headers: {
						Authorization: `Bearer ${authToken}`,
						"x-litellm-api-key": authToken,
					},
				})

				if (!contentResponse.ok) {
					const errorText = await contentResponse.text()
					return {
						success: false,
						error: `Video download failed: ${contentResponse.status} ${contentResponse.statusText}${
							errorText ? ` - ${errorText}` : ""
						}`,
					}
				}

				const buffer = new Uint8Array(await contentResponse.arrayBuffer())
				return {
					success: true,
					videoData: buffer,
					videoFormat: "mp4",
				}
			}

			if (status.status === "failed") {
				return { success: false, error: "Video generation failed" }
			}

			await sleep(pollIntervalMs)
		}

		return { success: false, error: "Video generation timed out before completion" }
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : t("tools:generateImage.unknownError"),
		}
	}
}
