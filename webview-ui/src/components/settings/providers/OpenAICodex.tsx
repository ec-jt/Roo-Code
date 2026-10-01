import React, { useEffect, useMemo, useRef, useState } from "react"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import {
	type ProviderSettings,
	type ModelInfo,
	openAiCodexDefaultModelId,
	openAiCodexModels,
} from "@roo-code/types"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"
import { vscode } from "@src/utils/vscode"

import { inputEventTransform } from "../transforms"
import { ModelPicker } from "../ModelPicker"
import { OpenAICodexRateLimitDashboard } from "./OpenAICodexRateLimitDashboard"

interface OpenAICodexProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
	simplifySettings?: boolean
	openAiCodexIsAuthenticated?: boolean
}

/**
 * Session-scoped cache of account-entitled model ids discovered from the ChatGPT backend.
 * Lives at module scope so switching settings tabs does not re-trigger discovery. Empty results
 * are not cached, so a transient failure can recover on the next mount.
 */
let sessionDiscoveredModelIds: string[] | null = null

/**
 * Sane defaults for account-entitled Codex ids that are not present in the static curated
 * catalog. Mirrors the shape of the flagship static entries (1.05M context, 128K output,
 * text + image, reasoning effort enabled).
 */
export const createOpenAiCodexFallbackModelInfo = (): ModelInfo => ({
	maxTokens: 128_000,
	contextWindow: 1_050_000,
	includedTools: ["apply_patch"],
	excludedTools: ["apply_diff", "write_to_file"],
	supportsImages: true,
	supportsPromptCache: true,
	supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
	reasoningEffort: "none",
	inputPrice: 0,
	outputPrice: 0,
	supportsVerbosity: true,
	supportsTemperature: false,
	description: "Account-entitled Codex model discovered from the ChatGPT backend",
})

/**
 * Merge discovered (account-entitled) ids into the static catalog. Static entries keep their
 * metadata; unknown ids receive sane defaults. When discovery is empty or undefined, the static
 * curated catalog is returned unchanged (the offline and first-run baseline).
 */
export const mergeOpenAiCodexModels = (discovered?: string[] | null): Record<string, ModelInfo> => {
	const merged: Record<string, ModelInfo> = { ...(openAiCodexModels as Record<string, ModelInfo>) }

	if (discovered) {
		for (const id of discovered) {
			if (typeof id === "string" && id.trim() && !merged[id]) {
				merged[id] = createOpenAiCodexFallbackModelInfo()
			}
		}
	}

	return merged
}

export const OpenAICodex: React.FC<OpenAICodexProps> = ({
	apiConfiguration,
	setApiConfigurationField,
	simplifySettings,
	openAiCodexIsAuthenticated = false,
}) => {
	const { t } = useAppTranslation()
	const [discoveredModelIds, setDiscoveredModelIds] = useState<string[] | null>(sessionDiscoveredModelIds)
	const hasRequestedDiscovery = useRef(false)
	const [callbackInput, setCallbackInput] = useState("")
	const [callbackError, setCallbackError] = useState<string | null>(null)
	const [isSubmittingCallback, setIsSubmittingCallback] = useState(false)

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data
			if (message?.type === "openAiCodexModels") {
				const ids = Array.isArray(message.openAiCodexModels) ? (message.openAiCodexModels as string[]) : []
				if (ids.length > 0) {
					sessionDiscoveredModelIds = ids
					setDiscoveredModelIds(ids)
				} else {
					// Empty discovery (including the silent empty-200 trap): keep/restore the static list.
					setDiscoveredModelIds(null)
				}
			} else if (message?.type === "openAiCodexCallbackResult") {
				setIsSubmittingCallback(false)
				if (message.success) {
					setCallbackInput("")
					setCallbackError(null)
				} else {
					setCallbackError(
						typeof message.error === "string" && message.error
							? message.error
							: t("settings:providers.openAiCodex.callbackFailed", {
									defaultValue: "Could not complete sign in.",
								}),
					)
				}
			}
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [t])

	const submitCallbackUrl = () => {
		const value = callbackInput.trim()
		if (!value) {
			setCallbackError(
				t("settings:providers.openAiCodex.callbackUrlRequired", {
					defaultValue: "Paste the callback URL from your browser first.",
				}),
			)
			return
		}
		setCallbackError(null)
		setIsSubmittingCallback(true)
		vscode.postMessage({ type: "openAiCodexSubmitCallbackUrl", text: value })
	}

	useEffect(() => {
		if (!openAiCodexIsAuthenticated) {
			hasRequestedDiscovery.current = false
			return
		}

		// Only ask once per session unless discovery previously came back empty.
		if (sessionDiscoveredModelIds || hasRequestedDiscovery.current) {
			return
		}

		hasRequestedDiscovery.current = true
		vscode.postMessage({ type: "requestOpenAiCodexModels" })
	}, [openAiCodexIsAuthenticated])

	const models = useMemo(() => mergeOpenAiCodexModels(discoveredModelIds), [discoveredModelIds])

	return (
		<div className="flex flex-col gap-4">
			{/* Authentication Section */}
			<div className="flex flex-col gap-2">
				{openAiCodexIsAuthenticated ? (
					<div className="flex justify-end">
						<Button
							variant="secondary"
							size="sm"
							onClick={() => vscode.postMessage({ type: "openAiCodexSignOut" })}>
							{t("settings:providers.openAiCodex.signOutButton", {
								defaultValue: "Sign Out",
							})}
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<Button
							variant="primary"
							onClick={() => vscode.postMessage({ type: "openAiCodexSignIn" })}
							className="w-fit">
							{t("settings:providers.openAiCodex.signInButton", {
								defaultValue: "Sign in to OpenAI Codex",
							})}
						</Button>

						{/*
							The OAuth redirect targets http://localhost:1455/auth/callback, so it only
							reaches this extension when the browser runs on the same machine as the
							extension host. Offer the manual hand-back for every other topology.
						*/}
						<div className="flex flex-col gap-2 rounded border border-vscode-panel-border p-3">
							<div className="text-sm text-vscode-descriptionForeground">
								{t("settings:providers.openAiCodex.remoteCallbackHint", {
									defaultValue:
										"Running Roo remotely (code-server, SSH remote, WSL or a dev container)? The login redirect points at localhost:1455 on your own machine, so it never reaches Roo. After signing in, copy the full URL from your browser address bar, even from the error page, and paste it here.",
								})}
							</div>
							<VSCodeTextField
								value={callbackInput}
								onInput={(e) => setCallbackInput(inputEventTransform(e) ?? "")}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault()
										submitCallbackUrl()
									}
								}}
								placeholder={t("settings:providers.openAiCodex.callbackUrlPlaceholder", {
									defaultValue: "http://localhost:1455/auth/callback?code=...",
								})}
								className="w-full">
								<label className="block font-medium mb-1">
									{t("settings:providers.openAiCodex.callbackUrlLabel", {
										defaultValue: "Callback URL",
									})}
								</label>
							</VSCodeTextField>
							<div className="flex flex-wrap items-center gap-2">
								<Button
									variant="secondary"
									size="sm"
									disabled={isSubmittingCallback}
									onClick={submitCallbackUrl}>
									{t("settings:providers.openAiCodex.completeSignInButton", {
										defaultValue: "Complete sign in",
									})}
								</Button>
								{callbackError && <span className="text-sm text-vscode-errorForeground">{callbackError}</span>}
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Rate Limit Dashboard - only shown when authenticated */}
			<OpenAICodexRateLimitDashboard isAuthenticated={openAiCodexIsAuthenticated} />

			{/* Model Picker */}
			<ModelPicker
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={setApiConfigurationField}
				defaultModelId={openAiCodexDefaultModelId}
				models={models}
				modelIdKey="apiModelId"
				serviceName="OpenAI - ChatGPT Plus/Pro"
				serviceUrl="https://chatgpt.com"
				simplifySettings={simplifySettings}
				hidePricing
			/>
		</div>
	)
}
