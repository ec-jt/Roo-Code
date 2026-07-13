import type OpenAI from "openai"

const GENERATE_VIDEO_DESCRIPTION = `Request to generate or edit a video using AI models through the configured video-generation provider. This tool can create new videos from text prompts or generate videos using an optional reference image. When an input image is provided, the AI will use it as a visual reference for the generated video.

Parameters:
- prompt: (required) The text prompt describing what video to generate
- path: (required) The file path where the generated video should be saved (relative to the current workspace directory). The tool will automatically add the appropriate video extension if not provided.
- image: (optional) The file path to an input image to use as a visual reference for the video. Supported formats: PNG, JPG, JPEG, GIF, WEBP.

Example: Generating a video
{ "prompt": "A cinematic drone shot flying over snowy mountains at sunrise", "path": "videos/mountains.mp4", "image": null }

Example: Generating a video from a reference image
{ "prompt": "Animate this image with subtle camera motion and drifting clouds", "path": "videos/animated-scene.mp4", "image": "images/scene.png" }`

const PROMPT_PARAMETER_DESCRIPTION = `Text description of the video to generate`

const PATH_PARAMETER_DESCRIPTION = `Filesystem path (relative to the workspace) where the resulting video should be saved`

const IMAGE_PARAMETER_DESCRIPTION = `Optional path (relative to the workspace) to an existing image to use as a reference; supports PNG, JPG, JPEG, GIF, and WEBP`

export default {
	type: "function",
	function: {
		name: "generate_video",
		description: GENERATE_VIDEO_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description: PROMPT_PARAMETER_DESCRIPTION,
				},
				path: {
					type: "string",
					description: PATH_PARAMETER_DESCRIPTION,
				},
				image: {
					type: ["string", "null"],
					description: IMAGE_PARAMETER_DESCRIPTION,
				},
			},
			required: ["prompt", "path", "image"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
