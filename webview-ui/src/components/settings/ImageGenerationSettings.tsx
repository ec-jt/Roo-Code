import React, { useEffect, useMemo, useRef, useState } from "react"
import {
	VSCodeButton,
	VSCodeCheckbox,
	VSCodeTextField,
	VSCodeDropdown,
	VSCodeOption,
} from "@vscode/webview-ui-toolkit/react"
import {
	IMAGE_GENERATION_MODELS,
	type ExtensionMessage,
	type ImageGenerationProvider,
	getImageGenerationProvider,
	getLiteLlmImageGenerationModelLabel,
	isLiteLlmImageGenerationModelId,
	isLiteLlmVideoGenerationModelId,
} from "@roo-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

interface ImageGenerationSettingsProps {
	enabled: boolean
	onChange: (enabled: boolean) => void
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	liteLlmImageApiKey?: string
	liteLlmImageBaseUrl?: string
	liteLlmImageGenerationSelectedModel?: string
	liteLlmImageEditingSelectedModel?: string
	liteLlmVideoGenerationSelectedModel?: string
	liteLlmProviderApiKey?: string
	setImageGenerationProvider: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey: (apiKey: string) => void
	setLiteLlmImageApiKey: (apiKey: string) => void
	setLiteLlmImageBaseUrl: (baseUrl: string) => void
	setImageGenerationSelectedModel: (model: string, provider?: ImageGenerationProvider) => void
	setLiteLlmImageEditingSelectedModel: (model: string) => void
	setLiteLlmVideoGenerationSelectedModel: (model: string) => void
}

export const ImageGenerationSettings = ({
	enabled,
	onChange,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	liteLlmImageApiKey,
	liteLlmImageBaseUrl,
	liteLlmImageGenerationSelectedModel,
	liteLlmImageEditingSelectedModel,
	liteLlmVideoGenerationSelectedModel,
	liteLlmProviderApiKey,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setLiteLlmImageApiKey,
	setLiteLlmImageBaseUrl,
	setImageGenerationSelectedModel,
	setLiteLlmImageEditingSelectedModel,
	setLiteLlmVideoGenerationSelectedModel,
}: ImageGenerationSettingsProps) => {
	const { t } = useAppTranslation()
	const { routerModels } = useExtensionState()
	const [refreshStatus, setRefreshStatus] = useState<"idle" | "loading" | "success" | "error">("idle")
	const [refreshError, setRefreshError] = useState<string | undefined>()
	const litellmErrorJustReceived = useRef(false)

	const currentProvider = getImageGenerationProvider(
		imageGenerationProvider,
		!!openRouterImageGenerationSelectedModel ||
			!!liteLlmImageGenerationSelectedModel ||
			!!liteLlmImageEditingSelectedModel,
	)

	const effectiveLiteLlmApiKey = liteLlmImageApiKey || liteLlmProviderApiKey || ""

	useEffect(() => {
		const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
			const message = event.data
			if (message.type === "singleRouterModelFetchResponse" && !message.success) {
				const providerName = message.values?.provider as string | undefined
				if (providerName === "litellm") {
					litellmErrorJustReceived.current = true
					setRefreshStatus("error")
					setRefreshError(message.error)
				}
			} else if (message.type === "routerModels") {
				const providerName = message.values?.provider as string | undefined
				if (providerName === "litellm" && refreshStatus === "loading") {
					if (!litellmErrorJustReceived.current) {
						setRefreshStatus("success")
						setRefreshError(undefined)
					}
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [refreshStatus])

	const handleLiteLlmRefreshModels = () => {
		litellmErrorJustReceived.current = false
		setRefreshStatus("loading")
		setRefreshError(undefined)

		if (!effectiveLiteLlmApiKey || !liteLlmImageBaseUrl) {
			setRefreshStatus("error")
			setRefreshError(t("settings:providers.refreshModels.missingConfig"))
			return
		}

		vscode.postMessage({
			type: "requestRouterModels",
			values: {
				provider: "litellm",
				litellmApiKey: effectiveLiteLlmApiKey,
				litellmBaseUrl: liteLlmImageBaseUrl,
			},
		})
	}

	const liteLlmAvailableModels = useMemo(() => {
		const litellmModels = routerModels?.litellm ?? {}
		return Object.entries(litellmModels)
			.filter(([modelId]) => isLiteLlmImageGenerationModelId(modelId))
			.map(([modelId]) => ({
				value: modelId,
				label: getLiteLlmImageGenerationModelLabel(modelId),
				provider: "litellm" as const,
			}))
			.sort((a, b) => a.label.localeCompare(b.label))
	}, [routerModels])

	const liteLlmVideoModels = useMemo(() => {
		const litellmModels = routerModels?.litellm ?? {}
		return Object.entries(litellmModels)
			.filter(([modelId]) => isLiteLlmVideoGenerationModelId(modelId))
			.map(([modelId]) => ({
				value: modelId,
				label: getLiteLlmImageGenerationModelLabel(modelId),
				provider: "litellm" as const,
			}))
			.sort((a, b) => a.label.localeCompare(b.label))
	}, [routerModels])

	const availableModels = useMemo(() => {
		if (currentProvider === "litellm") {
			return liteLlmAvailableModels
		}

		return IMAGE_GENERATION_MODELS.filter((model) => model.provider === currentProvider)
	}, [currentProvider, liteLlmAvailableModels])

	const selectedModelForProvider =
		currentProvider === "litellm" ? liteLlmImageGenerationSelectedModel : openRouterImageGenerationSelectedModel

	const displayModels = useMemo(() => {
		if (!selectedModelForProvider) {
			return availableModels
		}

		if (availableModels.some((model) => model.value === selectedModelForProvider)) {
			return availableModels
		}

		if (currentProvider === "litellm") {
			return [
				{
					value: selectedModelForProvider,
					label: getLiteLlmImageGenerationModelLabel(selectedModelForProvider),
					provider: "litellm" as const,
				},
				...availableModels,
			]
		}

		const staticModel = IMAGE_GENERATION_MODELS.find((model) => model.value === selectedModelForProvider)
		return staticModel ? [staticModel, ...availableModels] : availableModels
	}, [availableModels, currentProvider, selectedModelForProvider])

	const currentModel = useMemo(() => {
		if (selectedModelForProvider) {
			return selectedModelForProvider
		}

		return displayModels[0]?.value || IMAGE_GENERATION_MODELS[0]?.value || ""
	}, [displayModels, selectedModelForProvider])

	const editingDisplayModels = useMemo(() => {
		if (!liteLlmImageEditingSelectedModel) {
			return liteLlmAvailableModels
		}

		if (liteLlmAvailableModels.some((model) => model.value === liteLlmImageEditingSelectedModel)) {
			return liteLlmAvailableModels
		}

		return [
			{
				value: liteLlmImageEditingSelectedModel,
				label: getLiteLlmImageGenerationModelLabel(liteLlmImageEditingSelectedModel),
				provider: "litellm" as const,
			},
			...liteLlmAvailableModels,
		]
	}, [liteLlmAvailableModels, liteLlmImageEditingSelectedModel])

	const currentEditingModel = liteLlmImageEditingSelectedModel || ""

	const videoDisplayModels = useMemo(() => {
		if (!liteLlmVideoGenerationSelectedModel) {
			return liteLlmVideoModels
		}

		if (liteLlmVideoModels.some((model) => model.value === liteLlmVideoGenerationSelectedModel)) {
			return liteLlmVideoModels
		}

		return [
			{
				value: liteLlmVideoGenerationSelectedModel,
				label: getLiteLlmImageGenerationModelLabel(liteLlmVideoGenerationSelectedModel),
				provider: "litellm" as const,
			},
			...liteLlmVideoModels,
		]
	}, [liteLlmVideoGenerationSelectedModel, liteLlmVideoModels])

	const currentVideoModel = liteLlmVideoGenerationSelectedModel || ""

	useEffect(() => {
		if (currentProvider !== "litellm") {
			return
		}

		if (liteLlmImageGenerationSelectedModel) {
			return
		}

		const firstAvailableModel = liteLlmAvailableModels[0]?.value
		if (firstAvailableModel) {
			setImageGenerationSelectedModel(firstAvailableModel, "litellm")
		}
	}, [currentProvider, liteLlmAvailableModels, liteLlmImageGenerationSelectedModel, setImageGenerationSelectedModel])

	const handleProviderChange = (value: string) => {
		const newProvider = value as ImageGenerationProvider
		setImageGenerationProvider(newProvider)

		const providerModels =
			newProvider === "litellm"
				? liteLlmAvailableModels
				: IMAGE_GENERATION_MODELS.filter((m) => m.provider === newProvider)
		if (providerModels.length > 0) {
			setImageGenerationSelectedModel(providerModels[0].value, newProvider)
		}
	}

	const handleApiKeyChange = (value: string) => {
		if (currentProvider === "litellm") {
			setLiteLlmImageApiKey(value)
		} else {
			setOpenRouterImageApiKey(value)
		}
	}

	const handleModelChange = (value: string) => {
		setImageGenerationSelectedModel(value, currentProvider)
	}

	const handleEditingModelChange = (value: string) => {
		setLiteLlmImageEditingSelectedModel(value)
	}

	const handleVideoModelChange = (value: string) => {
		setLiteLlmVideoGenerationSelectedModel(value)
	}

	const requiresApiKey = true
	const isConfigured =
		currentProvider === "litellm" ? !!effectiveLiteLlmApiKey && !!liteLlmImageBaseUrl : !!openRouterImageApiKey

	return (
		<div className="space-y-4">
			<div>
				<div className="flex items-center gap-2">
					<VSCodeCheckbox checked={enabled} onChange={(e: any) => onChange(e.target.checked)}>
						<span className="font-medium">{t("settings:experimental.IMAGE_GENERATION.name")}</span>
					</VSCodeCheckbox>
				</div>
				<p className="text-vscode-descriptionForeground text-sm mt-0">
					{t("settings:experimental.IMAGE_GENERATION.description")}
				</p>
			</div>

			{enabled && (
				<div className="ml-2 space-y-3">
					<div>
						<label className="block font-medium mb-1">
							{t("settings:experimental.IMAGE_GENERATION.providerLabel")}
						</label>
						<VSCodeDropdown
							value={currentProvider}
							onChange={(e: any) => handleProviderChange(e.target.value)}
							className="w-full">
							<VSCodeOption value="openrouter" className="py-2 px-3">
								OpenRouter
							</VSCodeOption>
							<VSCodeOption value="litellm" className="py-2 px-3">
								LiteLLM
							</VSCodeOption>
						</VSCodeDropdown>
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							{t("settings:experimental.IMAGE_GENERATION.providerDescription")}
						</p>
					</div>

					<div>
						<label className="block font-medium mb-1">
							{currentProvider === "litellm"
								? t("settings:providers.litellmApiKey")
								: t("settings:experimental.IMAGE_GENERATION.openRouterApiKeyLabel")}
						</label>
						<VSCodeTextField
							value={
								currentProvider === "litellm" ? liteLlmImageApiKey || "" : openRouterImageApiKey || ""
							}
							onInput={(e: any) => handleApiKeyChange(e.target.value)}
							placeholder={
								currentProvider === "litellm"
									? t("settings:placeholders.apiKey")
									: t("settings:experimental.IMAGE_GENERATION.openRouterApiKeyPlaceholder")
							}
							className="w-full"
							type="password"
						/>
					</div>

					{currentProvider === "litellm" && (
						<div>
							<label className="block font-medium mb-1">{t("settings:providers.litellmBaseUrl")}</label>
							<VSCodeTextField
								value={liteLlmImageBaseUrl || ""}
								onInput={(e: any) => setLiteLlmImageBaseUrl(e.target.value)}
								placeholder={t("settings:placeholders.baseUrl")}
								className="w-full"
							/>
							<p className="text-vscode-descriptionForeground text-xs mt-1">
								Dedicated LiteLLM image-generation URL. This can differ from the normal LiteLLM chat
								endpoint.
							</p>
						</div>
					)}

					{currentProvider === "openrouter" ? (
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							{t("settings:experimental.IMAGE_GENERATION.getApiKeyText")}{" "}
							<a
								href="https://openrouter.ai/keys"
								target="_blank"
								rel="noopener noreferrer"
								className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground">
								openrouter.ai/keys
							</a>
						</p>
					) : (
						<div className="space-y-2">
							<VSCodeButton
								onClick={handleLiteLlmRefreshModels}
								disabled={
									refreshStatus === "loading" || !effectiveLiteLlmApiKey || !liteLlmImageBaseUrl
								}>
								{refreshStatus === "loading"
									? t("settings:providers.refreshModels.loading")
									: t("settings:providers.refreshModels.label")}
							</VSCodeButton>
							{refreshStatus === "success" && (
								<div className="text-sm text-vscode-foreground">
									{t("settings:providers.refreshModels.success")}
								</div>
							)}
							{refreshStatus === "error" && (
								<div className="text-sm text-vscode-errorForeground">
									{refreshError || t("settings:providers.refreshModels.error")}
								</div>
							)}
						</div>
					)}

					<div>
						<label className="block font-medium mb-1">
							{t("settings:experimental.IMAGE_GENERATION.modelSelectionLabel")}
						</label>
						<VSCodeDropdown
							value={currentModel}
							onChange={(e: any) => handleModelChange(e.target.value)}
							className="w-full">
							{displayModels.map((model) => (
								<VSCodeOption key={model.value} value={model.value} className="py-2 px-3">
									{model.label}
								</VSCodeOption>
							))}
						</VSCodeDropdown>
						<p className="text-vscode-descriptionForeground text-xs mt-1">
							{currentProvider === "litellm"
								? "LiteLLM image models are discovered from the configured image-generation endpoint using prefix and media-model heuristics."
								: t("settings:experimental.IMAGE_GENERATION.modelSelectionDescription")}
						</p>
					</div>

					{currentProvider === "litellm" && (
						<>
							<div>
								<label className="block font-medium mb-1">LiteLLM image-to-image model</label>
								<VSCodeDropdown
									value={currentEditingModel}
									onChange={(e: any) => handleEditingModelChange(e.target.value)}
									className="w-full">
									<VSCodeOption value="" className="py-2 px-3">
										Select image-to-image model
									</VSCodeOption>
									{editingDisplayModels.map((model) => (
										<VSCodeOption key={model.value} value={model.value} className="py-2 px-3">
											{model.label}
										</VSCodeOption>
									))}
								</VSCodeDropdown>
								<p className="text-vscode-descriptionForeground text-xs mt-1">
									Used only when an input image is provided for image-to-image editing. If empty, the
									normal image model is reused.
								</p>
							</div>

							<div>
								<label className="block font-medium mb-1">LiteLLM video model</label>
								<VSCodeDropdown
									value={currentVideoModel}
									onChange={(e: any) => handleVideoModelChange(e.target.value)}
									className="w-full">
									<VSCodeOption value="" className="py-2 px-3">
										Select video model
									</VSCodeOption>
									{videoDisplayModels.map((model) => (
										<VSCodeOption key={model.value} value={model.value} className="py-2 px-3">
											{model.label}
										</VSCodeOption>
									))}
								</VSCodeDropdown>
								<p className="text-vscode-descriptionForeground text-xs mt-1">
									Used by the dedicated video-generation tool with discovered `video/` LiteLLM models.
								</p>
							</div>
						</>
					)}

					{enabled && !isConfigured && (
						<div className="p-2 bg-vscode-editorWarning-background text-vscode-editorWarning-foreground rounded text-sm">
							{currentProvider === "litellm"
								? "LiteLLM image generation requires a dedicated LiteLLM image URL and API key."
								: t("settings:experimental.IMAGE_GENERATION.warningMissingKey")}
						</div>
					)}

					{enabled && currentProvider === "litellm" && isConfigured && availableModels.length === 0 && (
						<div className="p-2 bg-vscode-editorWarning-background text-vscode-editorWarning-foreground rounded text-sm">
							No LiteLLM image models were discovered. Expected `sd/` or `image/` prefixes, or supported
							Flux-style media model IDs.
						</div>
					)}

					{enabled && isConfigured && !(currentProvider === "litellm" && availableModels.length === 0) && (
						<div className="p-2 bg-vscode-editorInfo-background text-vscode-editorInfo-foreground rounded text-sm">
							{t("settings:experimental.IMAGE_GENERATION.successConfigured")}
						</div>
					)}
				</div>
			)}
		</div>
	)
}
