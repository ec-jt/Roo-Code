import { HTMLAttributes } from "react"

import type { Experiments, ImageGenerationProvider } from "@roo-code/types"

import { EXPERIMENT_IDS, experimentConfigsMap } from "@roo/experiments"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { cn } from "@src/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui"

import { SetCachedStateField, SetExperimentEnabled } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { ExperimentalFeature } from "./ExperimentalFeature"
import { ImageGenerationSettings } from "./ImageGenerationSettings"
import { NativeToolIntegrationsSettings } from "./NativeToolIntegrationsSettings"
import { CustomToolsSettings } from "./CustomToolsSettings"

type ExperimentalSettingsProps = HTMLAttributes<HTMLDivElement> & {
	experiments: Experiments
	setExperimentEnabled: SetExperimentEnabled
	cordisTextOnlyTurnPolicy?: "retryThenPause" | "alwaysPause"
	setCachedStateField?: SetCachedStateField<"cordisTextOnlyTurnPolicy">
	apiConfiguration?: any
	setApiConfigurationField?: any
	imageGenerationProvider?: ImageGenerationProvider
	openRouterImageApiKey?: string
	openRouterImageGenerationSelectedModel?: string
	liteLlmImageApiKey?: string
	liteLlmImageBaseUrl?: string
	liteLlmImageGenerationSelectedModel?: string
	liteLlmImageEditingSelectedModel?: string
	liteLlmVideoGenerationSelectedModel?: string
	braveApiKey?: string
	context7ApiKey?: string
	githubToken?: string
	nativeToolEnabled?: Record<string, boolean>
	setImageGenerationProvider?: (provider: ImageGenerationProvider) => void
	setOpenRouterImageApiKey?: (apiKey: string) => void
	setLiteLlmImageApiKey?: (apiKey: string) => void
	setLiteLlmImageBaseUrl?: (baseUrl: string) => void
	setImageGenerationSelectedModel?: (model: string, provider?: ImageGenerationProvider) => void
	setLiteLlmImageEditingSelectedModel?: (model: string) => void
	setLiteLlmVideoGenerationSelectedModel?: (model: string) => void
	setBraveApiKey?: (apiKey: string) => void
	setContext7ApiKey?: (apiKey: string) => void
	setGithubToken?: (token: string) => void
	setNativeToolEnabled?: (map: Record<string, boolean>) => void
}

export const ExperimentalSettings = ({
	experiments,
	setExperimentEnabled,
	cordisTextOnlyTurnPolicy,
	setCachedStateField,
	apiConfiguration,
	setApiConfigurationField,
	imageGenerationProvider,
	openRouterImageApiKey,
	openRouterImageGenerationSelectedModel,
	liteLlmImageApiKey,
	liteLlmImageBaseUrl,
	liteLlmImageGenerationSelectedModel,
	liteLlmImageEditingSelectedModel,
	liteLlmVideoGenerationSelectedModel,
	braveApiKey,
	context7ApiKey,
	githubToken,
	nativeToolEnabled,
	setImageGenerationProvider,
	setOpenRouterImageApiKey,
	setLiteLlmImageApiKey,
	setLiteLlmImageBaseUrl,
	setImageGenerationSelectedModel,
	setLiteLlmImageEditingSelectedModel,
	setLiteLlmVideoGenerationSelectedModel,
	setBraveApiKey,
	setContext7ApiKey,
	setGithubToken,
	setNativeToolEnabled,
	className,
	...props
}: ExperimentalSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.experimental")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="experimental-native-integrations"
					section="experimental"
					label="Native Tool Integrations">
					<NativeToolIntegrationsSettings
						braveApiKey={braveApiKey}
						context7ApiKey={context7ApiKey}
						githubToken={githubToken}
						nativeToolEnabled={nativeToolEnabled}
						setBraveApiKey={setBraveApiKey ?? (() => {})}
						setContext7ApiKey={setContext7ApiKey ?? (() => {})}
						setGithubToken={setGithubToken}
						setNativeToolEnabled={setNativeToolEnabled}
					/>
				</SearchableSetting>
				{Object.entries(experimentConfigsMap)
					.filter(([key]) => key in EXPERIMENT_IDS)
					.map((config) => {
						const experimentKey = config[0]
						const label = t(`settings:experimental.${experimentKey}.name`)

						if (
							config[0] === "IMAGE_GENERATION" &&
							setImageGenerationProvider &&
							setOpenRouterImageApiKey &&
							setLiteLlmImageApiKey &&
							setLiteLlmImageBaseUrl &&
							setImageGenerationSelectedModel &&
							setLiteLlmImageEditingSelectedModel &&
							setLiteLlmVideoGenerationSelectedModel
						) {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<ImageGenerationSettings
										enabled={experiments[EXPERIMENT_IDS.IMAGE_GENERATION] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.IMAGE_GENERATION, enabled)
										}
										imageGenerationProvider={imageGenerationProvider}
										openRouterImageApiKey={openRouterImageApiKey}
										openRouterImageGenerationSelectedModel={openRouterImageGenerationSelectedModel}
										liteLlmImageApiKey={liteLlmImageApiKey}
										liteLlmImageBaseUrl={liteLlmImageBaseUrl}
										liteLlmImageGenerationSelectedModel={liteLlmImageGenerationSelectedModel}
										liteLlmImageEditingSelectedModel={liteLlmImageEditingSelectedModel}
										liteLlmVideoGenerationSelectedModel={liteLlmVideoGenerationSelectedModel}
										liteLlmProviderApiKey={apiConfiguration?.litellmApiKey}
										setImageGenerationProvider={setImageGenerationProvider}
										setOpenRouterImageApiKey={setOpenRouterImageApiKey}
										setLiteLlmImageApiKey={setLiteLlmImageApiKey}
										setLiteLlmImageBaseUrl={setLiteLlmImageBaseUrl}
										setImageGenerationSelectedModel={setImageGenerationSelectedModel}
										setLiteLlmImageEditingSelectedModel={setLiteLlmImageEditingSelectedModel}
										setLiteLlmVideoGenerationSelectedModel={setLiteLlmVideoGenerationSelectedModel}
									/>
								</SearchableSetting>
							)
						}
						if (config[0] === "CUSTOM_TOOLS") {
							return (
								<SearchableSetting
									key={config[0]}
									settingId={`experimental-${config[0].toLowerCase()}`}
									section="experimental"
									label={label}>
									<CustomToolsSettings
										enabled={experiments[EXPERIMENT_IDS.CUSTOM_TOOLS] ?? false}
										onChange={(enabled) =>
											setExperimentEnabled(EXPERIMENT_IDS.CUSTOM_TOOLS, enabled)
										}
									/>
								</SearchableSetting>
							)
						}
						const feature = (
							<SearchableSetting
								key={config[0]}
								settingId={`experimental-${config[0].toLowerCase()}`}
								section="experimental"
								label={label}>
								<ExperimentalFeature
									experimentKey={config[0]}
									enabled={
										experiments[EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS]] ?? false
									}
									onChange={(enabled) =>
										setExperimentEnabled(
											EXPERIMENT_IDS[config[0] as keyof typeof EXPERIMENT_IDS],
											enabled,
										)
									}
								/>
							</SearchableSetting>
						)
						if (config[0] === "CORDIS_RUNTIME_PREVIEW" && setCachedStateField) {
							return (
								<div key={config[0]} className="flex flex-col gap-1">
									{feature}
									<SearchableSetting
										settingId="experimental-cordis-text-only-turn-policy"
										section="experimental"
										label={t("settings:experimental.cordisTextOnlyTurnPolicy.label")}
										className="pl-6">
										<span className="font-medium">
											{t("settings:experimental.cordisTextOnlyTurnPolicy.label")}
										</span>
										<Select
											value={cordisTextOnlyTurnPolicy ?? "retryThenPause"}
											onValueChange={(value) =>
												setCachedStateField(
													"cordisTextOnlyTurnPolicy",
													value as "retryThenPause" | "alwaysPause",
												)
											}>
											<SelectTrigger
												className="w-full mt-1"
												data-testid="cordis-text-only-turn-policy-select">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{(["retryThenPause", "alwaysPause"] as const).map((value) => (
													<SelectItem key={value} value={value}>
														{t(`settings:experimental.cordisTextOnlyTurnPolicy.${value}`)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<p className="text-sm text-vscode-descriptionForeground mt-1">
											{t("settings:experimental.cordisTextOnlyTurnPolicy.description")}
										</p>
									</SearchableSetting>
								</div>
							)
						}
						return feature
					})}
			</Section>
		</div>
	)
}
