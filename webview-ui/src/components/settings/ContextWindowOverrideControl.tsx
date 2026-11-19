import { useEffect, useState } from "react"

import { useAppTranslation } from "@/i18n/TranslationContext"

interface ContextWindowOverrideControlProps {
	value?: number
	onChange: (value: number | undefined) => void
}

/** Parses the field text. Empty or invalid input means no override. */
export const parseContextWindowOverride = (text: string): number | undefined => {
	const trimmed = text.trim()
	if (!/^\d+$/.test(trimmed)) return undefined
	const parsed = Number(trimmed)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

export const ContextWindowOverrideControl = ({ value, onChange }: ContextWindowOverrideControlProps) => {
	const { t } = useAppTranslation()
	const [text, setText] = useState(value === undefined ? "" : String(value))

	useEffect(() => {
		setText((current) =>
			parseContextWindowOverride(current) === value ? current : value === undefined ? "" : String(value),
		)
	}, [value])

	return (
		<div className="flex flex-col gap-1">
			<label htmlFor="context-window-override" className="block font-medium mb-1">
				{t("settings:providers.contextWindowOverride.label")}
			</label>
			<input
				id="context-window-override"
				className="w-full h-7 px-2 rounded-xs border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground focus:outline-0 focus:border-vscode-focusBorder"
				data-testid="context-window-override-input"
				type="text"
				inputMode="numeric"
				value={text}
				placeholder={t("settings:providers.contextWindowOverride.placeholder")}
				onChange={(event) => {
					const next = event.target.value
					setText(next)
					onChange(parseContextWindowOverride(next))
				}}
			/>
			<div className="text-sm text-vscode-descriptionForeground">
				{t("settings:providers.contextWindowOverride.description")}
			</div>
		</div>
	)
}
