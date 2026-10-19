import { useCallback } from "react"
import { VSCodeTextField, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { type ProviderSettings, type OrganizationAllowList, litellmDefaultModelId } from "@roo-code/types"

import type { useLiteLLMModels } from "@src/components/ui/hooks/useLiteLLMModels"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type LiteLLMProps = {
	discovery: ReturnType<typeof useLiteLLMModels>
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	organizationAllowList: OrganizationAllowList
	modelValidationError?: string
	simplifySettings?: boolean
}

export const LiteLLM = ({
	discovery,
	apiConfiguration,
	setApiConfigurationField,
	organizationAllowList,
	modelValidationError,
	simplifySettings,
}: LiteLLMProps) => {
	const { t } = useAppTranslation()
	const { models, status: refreshStatus, error: refreshError, refresh: handleRefreshModels } = discovery

	const handleInputChange = useCallback(
		<K extends keyof ProviderSettings, E>(
			field: K,
			transform: (event: E) => ProviderSettings[K] = inputEventTransform,
		) =>
			(event: E | Event) => {
				setApiConfigurationField(field, transform(event as E))
			},
		[setApiConfigurationField],
	)

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.litellmBaseUrl || ""}
				onInput={handleInputChange("litellmBaseUrl")}
				placeholder={t("settings:placeholders.baseUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.litellmBaseUrl")}</label>
			</VSCodeTextField>

			<VSCodeTextField
				value={apiConfiguration?.litellmApiKey || ""}
				type="password"
				onInput={handleInputChange("litellmApiKey")}
				placeholder={t("settings:placeholders.apiKey")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.litellmApiKey")}</label>
			</VSCodeTextField>

			<div className="text-sm text-vscode-descriptionForeground -mt-2">
				{t("settings:providers.apiKeyStorageNotice")}
			</div>

			<Button
				variant="outline"
				onClick={handleRefreshModels}
				disabled={
					refreshStatus === "loading" || !apiConfiguration.litellmApiKey || !apiConfiguration.litellmBaseUrl
				}
				className="w-full">
				<div className="flex items-center gap-2">
					{refreshStatus === "loading" ? (
						<span className="codicon codicon-loading codicon-modifier-spin" />
					) : (
						<span className="codicon codicon-refresh" />
					)}
					{t("settings:providers.refreshModels.label")}
				</div>
			</Button>
			{refreshStatus === "loading" && (
				<div className="text-sm text-vscode-descriptionForeground">
					{t("settings:providers.refreshModels.loading")}
				</div>
			)}
			{refreshStatus === "success" && (
				<div className="text-sm text-vscode-foreground">
					{Object.keys(models).length === 0
						? "The proxy returned no models. Check model discovery access for this API key."
						: t("settings:providers.refreshModels.success")}
				</div>
			)}
			{refreshStatus === "error" && (
				<div className="text-sm text-vscode-errorForeground">
					{refreshError || t("settings:providers.refreshModels.error")}
				</div>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				defaultModelId={litellmDefaultModelId}
				models={models}
				modelIdKey="litellmModelId"
				serviceName="LiteLLM"
				serviceUrl="https://docs.litellm.ai/"
				setApiConfigurationField={setApiConfigurationField}
				organizationAllowList={organizationAllowList}
				errorMessage={modelValidationError}
				simplifySettings={simplifySettings}
			/>

			{/* Show prompt caching option if the selected model supports it */}
			{(() => {
				const selectedModelId = apiConfiguration.litellmModelId || litellmDefaultModelId
				const selectedModel = models[selectedModelId]
				if (selectedModel?.supportsPromptCache) {
					return (
						<div className="mt-4">
							<VSCodeCheckbox
								checked={apiConfiguration.litellmUsePromptCache || false}
								onChange={(e: any) => {
									setApiConfigurationField("litellmUsePromptCache", e.target.checked)
								}}>
								<span className="font-medium">{t("settings:providers.enablePromptCaching")}</span>
							</VSCodeCheckbox>
							<div className="text-sm text-vscode-descriptionForeground ml-6 mt-1">
								{t("settings:providers.enablePromptCachingTitle")}
							</div>
						</div>
					)
				}
				return null
			})()}
		</>
	)
}
