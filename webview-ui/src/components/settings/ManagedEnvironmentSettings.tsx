import { useTranslation } from "react-i18next"
import type { ExtensionState } from "@roo-code/types"

const fields = [
	["managedEnvironmentsRoot", "root", "text"],
	["managedEnvironmentsPythonPath", "python", "text"],
	["managedEnvironmentsMaxDownloadMb", "download", "number"],
	["managedEnvironmentsMaxDiskMb", "disk", "number"],
	["managedEnvironmentsTimeoutSeconds", "timeout", "number"],
] as const
type Field = (typeof fields)[number][0] | "managedEnvironmentsEnabled" | "alwaysAllowManagedEnvironments"
export function ManagedEnvironmentSettings({
	state,
	setField,
}: {
	state: ExtensionState
	setField: <K extends Field>(key: K, value: ExtensionState[K]) => void
}) {
	const { t } = useTranslation()
	return (
		<section className="mt-6 space-y-3 border-t border-vscode-panel-border pt-4">
			<h3>{t("settings:managedEnvironments.title")}</h3>
			<p className="text-sm text-vscode-descriptionForeground">{t("settings:managedEnvironments.description")}</p>
			<label className="flex gap-2 items-center">
				<input
					type="checkbox"
					checked={state.managedEnvironmentsEnabled ?? false}
					onChange={(e) => setField("managedEnvironmentsEnabled", e.target.checked)}
				/>
				{t("settings:managedEnvironments.enabled")}
			</label>
			{fields.map(([key, label, type]) => (
				<label key={key} className="block text-sm">
					<span className="block mb-1">{t(`settings:managedEnvironments.${label}`)}</span>
					<input
						className="w-full border border-vscode-panel-border rounded px-2 py-1 bg-transparent"
						type={type}
						value={
							state[key] ??
							(key === "managedEnvironmentsMaxDownloadMb"
								? 512
								: key === "managedEnvironmentsMaxDiskMb"
									? 2048
									: key === "managedEnvironmentsTimeoutSeconds"
										? 600
										: "")
						}
						min={type === "number" ? 1 : undefined}
						onChange={(e) => setField(key, type === "number" ? Number(e.target.value) : e.target.value)}
					/>
				</label>
			))}
			<label className="flex gap-2 items-center">
				<input
					type="checkbox"
					checked={state.alwaysAllowManagedEnvironments ?? false}
					onChange={(e) => setField("alwaysAllowManagedEnvironments", e.target.checked)}
				/>
				{t("settings:managedEnvironments.autoApprove")}
			</label>
			<p className="text-sm text-vscode-descriptionForeground">{t("settings:managedEnvironments.warning")}</p>
		</section>
	)
}
