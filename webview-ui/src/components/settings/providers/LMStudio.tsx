import { useCallback, useState, useMemo, useEffect, useRef } from "react"
import { useEvent } from "react-use"
import { Trans } from "react-i18next"
import { Checkbox } from "vscrui"
import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings, ExtensionMessage, ModelRecord } from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useRouterModels } from "@src/components/ui/hooks/useRouterModels"
import { vscode } from "@src/utils/vscode"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"

type LMStudioProps = {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const LMStudio = ({ apiConfiguration, setApiConfigurationField }: LMStudioProps) => {
	const { t } = useAppTranslation()

	const [lmStudioModels, setLmStudioModels] = useState<ModelRecord>({})
	const [discoveryError, setDiscoveryError] = useState<string>()
	const [loading, setLoading] = useState(false)
	const [refresh, setRefresh] = useState(0)
	const pendingRequest = useRef<string>()
	const deadline = useRef<ReturnType<typeof setTimeout>>()
	const routerModels = useRouterModels()

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

	const onMessage = useCallback((event: MessageEvent) => {
		const message: ExtensionMessage = event.data

		switch (message.type) {
			case "lmStudioModels":
				{
					if (!pendingRequest.current || message.lmStudioModelsRequestId !== pendingRequest.current) return
					pendingRequest.current = undefined
					clearTimeout(deadline.current)
					setLoading(false)
					setDiscoveryError(message.lmStudioModelsError)
					const newModels = message.lmStudioModels ?? {}
					setLmStudioModels(newModels)
				}
				break
		}
	}, [])

	useEvent("message", onMessage)

	// Use draft values, not the previously saved profile. Ignore stale responses.
	useEffect(() => {
		const requestId = crypto.randomUUID()
		pendingRequest.current = requestId
		setLmStudioModels({})
		setDiscoveryError(undefined)
		setLoading(true)
		const timer = setTimeout(() => {
			vscode.postMessage({
				type: "requestLmStudioModels",
				values: {
					requestId,
					baseUrl: apiConfiguration.lmStudioBaseUrl ?? "",
					apiKey: apiConfiguration.lmStudioApiKey ?? "",
				},
			})
			deadline.current = setTimeout(() => {
				if (pendingRequest.current !== requestId) return
				pendingRequest.current = undefined
				setLoading(false)
				setDiscoveryError("LM Studio discovery timed out. Check the server connection and refresh.")
			}, 35_000)
		}, 300)
		return () => {
			clearTimeout(timer)
			clearTimeout(deadline.current)
			pendingRequest.current = undefined
		}
	}, [apiConfiguration.lmStudioBaseUrl, apiConfiguration.lmStudioApiKey, refresh])

	// Check if the selected model exists in the fetched models
	const modelNotAvailableError = useMemo(() => {
		const selectedModel = apiConfiguration?.lmStudioModelId
		if (!selectedModel) return undefined

		// Check if model exists in local LM Studio models
		if (Object.keys(lmStudioModels).length > 0 && selectedModel in lmStudioModels) {
			return undefined // Model is available locally
		}

		// If we have router models data for LM Studio
		if (routerModels.data?.lmstudio) {
			const availableModels = Object.keys(routerModels.data.lmstudio)
			// Show warning if model is not in the list (regardless of how many models there are)
			if (!availableModels.includes(selectedModel)) {
				return t("settings:validation.modelAvailability", { modelId: selectedModel })
			}
		}

		// If neither source has loaded yet, don't show warning
		return undefined
	}, [apiConfiguration?.lmStudioModelId, routerModels.data, lmStudioModels, t])

	// Check if the draft model exists
	const draftModelNotAvailableError = useMemo(() => {
		const draftModel = apiConfiguration?.lmStudioDraftModelId
		if (!draftModel) return undefined

		// Check if model exists in local LM Studio models
		if (Object.keys(lmStudioModels).length > 0 && draftModel in lmStudioModels) {
			return undefined // Model is available locally
		}

		// If we have router models data for LM Studio
		if (routerModels.data?.lmstudio) {
			const availableModels = Object.keys(routerModels.data.lmstudio)
			// Show warning if model is not in the list (regardless of how many models there are)
			if (!availableModels.includes(draftModel)) {
				return t("settings:validation.modelAvailability", { modelId: draftModel })
			}
		}

		// If neither source has loaded yet, don't show warning
		return undefined
	}, [apiConfiguration?.lmStudioDraftModelId, routerModels.data, lmStudioModels, t])

	return (
		<>
			<VSCodeTextField
				value={apiConfiguration?.lmStudioBaseUrl || ""}
				type="url"
				onInput={handleInputChange("lmStudioBaseUrl")}
				placeholder={t("settings:defaults.lmStudioUrl")}
				className="w-full">
				<label className="block font-medium mb-1">{t("settings:providers.lmStudio.baseUrl")}</label>
			</VSCodeTextField>
			<VSCodeTextField
				value={apiConfiguration.lmStudioApiKey || ""}
				type="password"
				onInput={handleInputChange("lmStudioApiKey")}
				className="w-full">
				<label className="block font-medium mb-1">API token (optional)</label>
			</VSCodeTextField>
			<p className="text-sm text-vscode-descriptionForeground">
				Leave blank when LM Studio does not require authentication. Use the server URL; a trailing /v1 is
				accepted. Downloaded chat models and loaded instances are listed when the server exposes them.
			</p>
			<button
				type="button"
				className="text-vscode-textLink-foreground"
				onClick={() => setRefresh((value) => value + 1)}>
				Refresh models
			</button>
			{loading && <p role="status">Loading LM Studio models...</p>}
			{discoveryError && <p role="alert">{discoveryError}</p>}
			{!loading && !discoveryError && Object.keys(lmStudioModels).length === 0 && (
				<p role="status">No chat models were returned by this server.</p>
			)}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId=""
				models={lmStudioModels}
				modelIdKey="lmStudioModelId"
				serviceName="LM Studio"
				serviceUrl="https://lmstudio.ai/docs"
				errorMessage={modelNotAvailableError}
				hidePricing
			/>
			<Checkbox
				checked={apiConfiguration?.lmStudioSpeculativeDecodingEnabled === true}
				onChange={(checked) => {
					setApiConfigurationField("lmStudioSpeculativeDecodingEnabled", checked)
				}}>
				{t("settings:providers.lmStudio.speculativeDecoding")}
			</Checkbox>
			{apiConfiguration?.lmStudioSpeculativeDecodingEnabled && (
				<>
					<ModelPicker
						apiConfiguration={apiConfiguration}
						setApiConfigurationField={setApiConfigurationField}
						defaultModelId=""
						models={lmStudioModels}
						modelIdKey="lmStudioDraftModelId"
						serviceName="LM Studio"
						serviceUrl="https://lmstudio.ai/docs"
						label={t("settings:providers.lmStudio.draftModelId")}
						errorMessage={draftModelNotAvailableError}
						hidePricing
					/>
					<div className="text-sm text-vscode-descriptionForeground">
						{t("settings:providers.lmStudio.draftModelDesc")}
					</div>
				</>
			)}
			<div className="text-sm text-vscode-descriptionForeground">
				<Trans
					i18nKey="settings:providers.lmStudio.description"
					components={{
						a: <VSCodeLink href="https://lmstudio.ai/docs" />,
						b: <VSCodeLink href="https://lmstudio.ai/docs/basics/server" />,
						span: (
							<span className="text-vscode-errorForeground ml-1">
								<span className="font-medium">Note:</span>
							</span>
						),
					}}
				/>
			</div>
		</>
	)
}
