import { render, fireEvent } from "@testing-library/react"

import { ImageGenerationSettings } from "../ImageGenerationSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		routerModels: {
			litellm: {
				"image/demo-model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					supportsImages: true,
				},
				"video/demo-model": {
					maxTokens: 8192,
					contextWindow: 128000,
					supportsPromptCache: false,
					supportsImages: true,
				},
			},
		},
	}),
}))

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

describe("ImageGenerationSettings", () => {
	const mockSetImageGenerationProvider = vi.fn()
	const mockSetOpenRouterImageApiKey = vi.fn()
	const mockSetLiteLlmImageApiKey = vi.fn()
	const mockSetLiteLlmImageBaseUrl = vi.fn()
	const mockSetImageGenerationSelectedModel = vi.fn()
	const mockOnChange = vi.fn()

	const defaultProps = {
		enabled: false,
		onChange: mockOnChange,
		imageGenerationProvider: undefined,
		openRouterImageApiKey: undefined,
		openRouterImageGenerationSelectedModel: undefined,
		liteLlmImageApiKey: undefined,
		liteLlmImageBaseUrl: "https://link.mostlyharmless.im",
		liteLlmImageGenerationSelectedModel: undefined,
		liteLlmImageEditingSelectedModel: undefined,
		liteLlmVideoGenerationSelectedModel: undefined,
		liteLlmProviderApiKey: "provider-key",
		setImageGenerationProvider: mockSetImageGenerationProvider,
		setOpenRouterImageApiKey: mockSetOpenRouterImageApiKey,
		setLiteLlmImageApiKey: mockSetLiteLlmImageApiKey,
		setLiteLlmImageBaseUrl: mockSetLiteLlmImageBaseUrl,
		setImageGenerationSelectedModel: mockSetImageGenerationSelectedModel,
		setLiteLlmImageEditingSelectedModel: vi.fn(),
		setLiteLlmVideoGenerationSelectedModel: vi.fn(),
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("Initial Mount Behavior", () => {
		it("should not call setter functions on initial mount with empty configuration", () => {
			render(<ImageGenerationSettings {...defaultProps} />)

			expect(mockSetImageGenerationProvider).not.toHaveBeenCalled()
			expect(mockSetOpenRouterImageApiKey).not.toHaveBeenCalled()
			expect(mockSetLiteLlmImageApiKey).not.toHaveBeenCalled()
			expect(mockSetLiteLlmImageBaseUrl).not.toHaveBeenCalled()
			expect(mockSetImageGenerationSelectedModel).not.toHaveBeenCalled()
		})

		it("should not call setter functions on initial mount with existing configuration", () => {
			render(
				<ImageGenerationSettings
					{...defaultProps}
					openRouterImageApiKey="existing-key"
					openRouterImageGenerationSelectedModel="google/gemini-2.5-flash-image"
				/>,
			)

			expect(mockSetImageGenerationProvider).not.toHaveBeenCalled()
			expect(mockSetOpenRouterImageApiKey).not.toHaveBeenCalled()
			expect(mockSetLiteLlmImageApiKey).not.toHaveBeenCalled()
			expect(mockSetLiteLlmImageBaseUrl).not.toHaveBeenCalled()
			expect(mockSetImageGenerationSelectedModel).not.toHaveBeenCalled()
		})
	})

	describe("User Interaction Behavior", () => {
		it("should call the OpenRouter setter when user changes the OpenRouter API key", async () => {
			const { getByPlaceholderText } = render(
				<ImageGenerationSettings {...defaultProps} enabled={true} imageGenerationProvider="openrouter" />,
			)

			const apiKeyInput = getByPlaceholderText(
				"settings:experimental.IMAGE_GENERATION.openRouterApiKeyPlaceholder",
			)

			fireEvent.input(apiKeyInput, { target: { value: "new-api-key" } })

			expect(defaultProps.setOpenRouterImageApiKey).toHaveBeenCalledWith("new-api-key")
		})

		it("should call the LiteLLM setters when user changes the LiteLLM credentials", async () => {
			const { getByPlaceholderText } = render(
				<ImageGenerationSettings {...defaultProps} enabled={true} imageGenerationProvider="litellm" />,
			)

			const apiKeyInput = getByPlaceholderText("settings:placeholders.apiKey")
			const baseUrlInput = getByPlaceholderText("settings:placeholders.baseUrl")

			fireEvent.input(apiKeyInput, { target: { value: "litellm-image-key" } })
			fireEvent.input(baseUrlInput, { target: { value: "https://media.example.test" } })

			expect(defaultProps.setLiteLlmImageApiKey).toHaveBeenCalledWith("litellm-image-key")
			expect(defaultProps.setLiteLlmImageBaseUrl).toHaveBeenCalledWith("https://media.example.test")
		})

		it("should auto-select the first discovered LiteLLM image model when none is saved", () => {
			render(<ImageGenerationSettings {...defaultProps} enabled={true} imageGenerationProvider="litellm" />)

			expect(defaultProps.setImageGenerationSelectedModel).toHaveBeenCalledWith("image/demo-model", "litellm")
		})
	})

	describe("Conditional Rendering", () => {
		it("should render OpenRouter input fields when enabled is true and provider is openrouter", () => {
			const { getByPlaceholderText } = render(
				<ImageGenerationSettings {...defaultProps} enabled={true} imageGenerationProvider="openrouter" />,
			)

			expect(
				getByPlaceholderText("settings:experimental.IMAGE_GENERATION.openRouterApiKeyPlaceholder"),
			).toBeInTheDocument()
		})

		it("should render LiteLLM input fields when enabled is true and provider is litellm", () => {
			const { getByPlaceholderText, getByText } = render(
				<ImageGenerationSettings {...defaultProps} enabled={true} imageGenerationProvider="litellm" />,
			)

			expect(getByPlaceholderText("settings:placeholders.apiKey")).toBeInTheDocument()
			expect(getByPlaceholderText("settings:placeholders.baseUrl")).toBeInTheDocument()
			expect(getByText("settings:providers.refreshModels.label")).toBeInTheDocument()
			expect(getByText("LiteLLM image-to-image model")).toBeInTheDocument()
			expect(getByText("LiteLLM video model")).toBeInTheDocument()
		})

		it("should keep showing a saved LiteLLM image model after reload before models are refreshed", () => {
			const { getByText } = render(
				<ImageGenerationSettings
					{...defaultProps}
					enabled={true}
					imageGenerationProvider="litellm"
					liteLlmImageGenerationSelectedModel="image/saved-model"
				/>,
			)

			expect(getByText("Saved Model")).toBeInTheDocument()
		})

		it("should not render input fields when enabled is false", () => {
			const { queryByPlaceholderText } = render(<ImageGenerationSettings {...defaultProps} enabled={false} />)

			expect(
				queryByPlaceholderText("settings:experimental.IMAGE_GENERATION.openRouterApiKeyPlaceholder"),
			).not.toBeInTheDocument()
		})
	})
})
