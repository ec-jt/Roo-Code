import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { HTMLAttributes, useEffect, useState } from "react"

import { Button, Textarea } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SetCachedStateField } from "./types"

/** Splits the allowlist text into one trimmed, non-empty entry per line. */
export function parseAllowedApps(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

export interface ComputerUsePermissionsResult {
	success: boolean
	text: string
	remedy: string[]
	warnings: string[]
}

type ComputerUseSettingsProps = HTMLAttributes<HTMLDivElement> & {
	computerUseEnabled?: boolean
	computerUseAllowedApps?: string[]
	computerUseBackgroundMode?: boolean
	setCachedStateField: SetCachedStateField<
		"computerUseEnabled" | "computerUseAllowedApps" | "computerUseBackgroundMode"
	>
}

export const ComputerUseSettings = ({
	computerUseEnabled,
	computerUseAllowedApps,
	computerUseBackgroundMode,
	setCachedStateField,
	...props
}: ComputerUseSettingsProps) => {
	const { t } = useAppTranslation()

	// Keep the raw text locally so that typing a new line is not lost when the list is re-joined.
	const [allowedAppsText, setAllowedAppsText] = useState(() => (computerUseAllowedApps ?? []).join("\n"))
	const [checking, setChecking] = useState(false)
	const [permissionsResult, setPermissionsResult] = useState<ComputerUsePermissionsResult | null>(null)

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data

			if (message?.type === "computerUsePermissionsResult") {
				setPermissionsResult({
					success: !!message.success,
					text: message.text ?? "",
					remedy: Array.isArray(message.values?.remedy) ? message.values.remedy : [],
					warnings: Array.isArray(message.values?.warnings) ? message.values.warnings : [],
				})
				setChecking(false)
			}
		}

		window.addEventListener("message", handleMessage)

		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [])

	const checkPermissions = () => {
		setChecking(true)
		setPermissionsResult(null)
		vscode.postMessage({ type: "checkComputerUsePermissions" })
	}

	return (
		<div {...props}>
			<SectionHeader>{t("settings:sections.computerUse")}</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="computer-use-enable"
					section="computerUse"
					label={t("settings:computerUse.enable.label")}>
					<VSCodeCheckbox
						checked={computerUseEnabled ?? false}
						onChange={(e: any) => setCachedStateField("computerUseEnabled", e.target.checked)}
						data-testid="computer-use-enabled-checkbox">
						<span className="font-medium">{t("settings:computerUse.enable.label")}</span>
					</VSCodeCheckbox>
					<div className="text-vscode-descriptionForeground text-sm mt-1">
						{t("settings:computerUse.enable.description")}
					</div>
					<div className="p-2 mt-2 rounded-xs text-sm bg-red-800/20 text-red-400">
						{t("settings:computerUse.enable.warning")}
					</div>
				</SearchableSetting>

				{computerUseEnabled && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="computer-use-background-mode"
							section="computerUse"
							label={t("settings:computerUse.backgroundMode.label")}>
							<VSCodeCheckbox
								checked={computerUseBackgroundMode ?? false}
								onChange={(e: any) =>
									setCachedStateField("computerUseBackgroundMode", e.target.checked)
								}
								data-testid="computer-use-background-mode-checkbox">
								<span className="font-medium">{t("settings:computerUse.backgroundMode.label")}</span>
							</VSCodeCheckbox>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:computerUse.backgroundMode.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="computer-use-allowed-apps"
							section="computerUse"
							label={t("settings:computerUse.allowedApps.label")}>
							<label className="block font-medium mb-1" htmlFor="computer-use-allowed-apps">
								{t("settings:computerUse.allowedApps.label")}
							</label>
							<Textarea
								id="computer-use-allowed-apps"
								data-testid="computer-use-allowed-apps"
								value={allowedAppsText}
								rows={4}
								placeholder={t("settings:computerUse.allowedApps.placeholder")}
								onChange={(e) => {
									setAllowedAppsText(e.target.value)
									setCachedStateField("computerUseAllowedApps", parseAllowedApps(e.target.value))
								}}
							/>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:computerUse.allowedApps.description")}
							</div>
						</SearchableSetting>

						<SearchableSetting
							settingId="computer-use-permissions"
							section="computerUse"
							label={t("settings:computerUse.permissions.label")}>
							<label className="block font-medium mb-1">
								{t("settings:computerUse.permissions.label")}
							</label>
							<div className="flex items-center gap-2">
								<Button
									disabled={checking}
									onClick={checkPermissions}
									data-testid="computer-use-check-permissions">
									{checking
										? t("settings:computerUse.permissions.checkingButton")
										: t("settings:computerUse.permissions.checkButton")}
								</Button>
							</div>
							<div className="text-vscode-descriptionForeground text-sm mt-1">
								{t("settings:computerUse.permissions.description")}
							</div>
							{permissionsResult && (
								<div
									data-testid="computer-use-permissions-result"
									className={`p-2 mt-2 rounded-xs text-sm ${
										permissionsResult.success
											? "bg-green-800/20 text-green-400"
											: "bg-red-800/20 text-red-400"
									}`}>
									<div>
										{permissionsResult.success
											? t("settings:computerUse.permissions.ok")
											: permissionsResult.text}
									</div>
									{permissionsResult.remedy.length > 0 && (
										<ol className="mt-1 mb-0 pl-5">
											{permissionsResult.remedy.map((step, i) => (
												<li key={i}>{step}</li>
											))}
										</ol>
									)}
									{permissionsResult.warnings.length > 0 && (
										<ul className="mt-1 mb-0 pl-5">
											{permissionsResult.warnings.map((warning, i) => (
												<li key={i}>{warning}</li>
											))}
										</ul>
									)}
								</div>
							)}
						</SearchableSetting>

						<div className="text-vscode-descriptionForeground text-sm">
							{t("settings:computerUse.visionRequired")}
						</div>
						<div className="text-vscode-descriptionForeground text-sm">
							{t("settings:computerUse.stopShortcut")}
						</div>
					</div>
				)}
			</Section>
		</div>
	)
}
