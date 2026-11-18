import { memo, useMemo } from "react"
import { useTranslation } from "react-i18next"
import {
	AppWindow,
	ArrowDown,
	ArrowLeft,
	ArrowRight,
	ArrowUp,
	Camera,
	Clock,
	Keyboard,
	List,
	Monitor,
	Move,
	MousePointer,
	MousePointerClick,
	Type,
} from "lucide-react"

import type { ClineMessage, ClineSayComputerAction, ComputerActionResult } from "@roo-code/types"

import { ImageViewer } from "../common/ImageViewer"

/** Maximum characters of typed text shown in the compact (say) row. */
export const COMPUTER_ACTION_TEXT_PREVIEW_LENGTH = 200

function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) {
		return undefined
	}
	try {
		const value = JSON.parse(text)
		return value && typeof value === "object" ? (value as T) : undefined
	} catch {
		return undefined
	}
}

const iconClass = "w-3.5 h-3.5 shrink-0 opacity-70"

function getActionIcon(action: string, direction?: string) {
	switch (action) {
		case "screenshot":
		case "window_screenshot":
			return <Camera className={iconClass} />
		case "window_type":
			return <Type className={iconClass} />
		case "list_elements":
			return <List className={iconClass} />
		case "click_element":
			return <MousePointerClick className={iconClass} />
		case "click":
		case "double_click":
		case "right_click":
			return <MousePointerClick className={iconClass} />
		case "move":
			return <MousePointer className={iconClass} />
		case "drag":
			return <Move className={iconClass} />
		case "type":
			return <Type className={iconClass} />
		case "key":
			return <Keyboard className={iconClass} />
		case "scroll":
			switch (direction) {
				case "up":
					return <ArrowUp className={iconClass} />
				case "left":
					return <ArrowLeft className={iconClass} />
				case "right":
					return <ArrowRight className={iconClass} />
				default:
					return <ArrowDown className={iconClass} />
			}
		case "list_windows":
			return <List className={iconClass} />
		case "focus_window":
			return <AppWindow className={iconClass} />
		case "wait":
			return <Clock className={iconClass} />
		default:
			return <Monitor className={iconClass} />
	}
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

interface ComputerActionRowProps {
	message: ClineMessage
}

/**
 * Renders the `computer_action` ask (approval request) and say (executed action).
 * For the ask, typed text is always shown in full so the user sees exactly what will be typed.
 */
export const ComputerActionRow = memo(({ message }: ComputerActionRowProps) => {
	const { t } = useTranslation()
	const isAsk = message.type === "ask"
	const payload = useMemo(() => parseJson<ClineSayComputerAction>(message.text), [message.text])

	if (!payload?.action) {
		return null
	}

	const { action } = payload
	const details: { label: string; value: string; testId: string }[] = []

	if (payload.coordinate) {
		details.push({ label: t("chat:computerAction.coordinate"), value: payload.coordinate, testId: "coordinate" })
	}
	if (payload.endCoordinate) {
		details.push({
			label: t("chat:computerAction.endCoordinate"),
			value: payload.endCoordinate,
			testId: "end-coordinate",
		})
	}
	if (payload.key) {
		details.push({ label: t("chat:computerAction.key"), value: payload.key, testId: "key" })
	}
	if (payload.direction) {
		const amount = payload.amount !== undefined ? ` × ${payload.amount}` : ""
		details.push({
			label: t("chat:computerAction.scroll"),
			value: `${payload.direction}${amount}`,
			testId: "scroll",
		})
	}
	if (payload.window) {
		details.push({ label: t("chat:computerAction.window"), value: payload.window, testId: "window" })
	}
	if (payload.duration !== undefined) {
		details.push({
			label: t("chat:computerAction.duration"),
			value: `${payload.duration} ms`,
			testId: "duration",
		})
	}

	const typedText = payload.text
	const shownText =
		typedText === undefined
			? undefined
			: isAsk
				? typedText
				: truncate(typedText, COMPUTER_ACTION_TEXT_PREVIEW_LENGTH)

	return (
		<div className="px-[15px] py-[10px] pr-[6px]" data-testid="computer-action-row">
			<div className="flex items-center gap-2 font-bold">
				<Monitor className="w-4 h-4 shrink-0" />
				<span>{isAsk ? t("chat:computerAction.wantsToAct") : t("chat:computerAction.title")}</span>
			</div>
			<div className="mt-1 ml-6 flex flex-col gap-1 text-sm">
				<div className="flex items-center gap-2">
					{getActionIcon(action, payload.direction)}
					<span className="font-mono" data-testid="computer-action-name">
						{t(`chat:computerAction.actions.${action}`, { defaultValue: action })}
					</span>
				</div>
				{details.map(({ label, value, testId }) => (
					<div key={testId} className="flex items-baseline gap-2" data-testid={`computer-action-${testId}`}>
						<span className="text-vscode-descriptionForeground">{label}:</span>
						<span className="font-mono break-all">{value}</span>
						{testId === "coordinate" && payload.executedCoordinate && (
							<span
								className="text-xs text-vscode-descriptionForeground"
								data-testid="computer-action-executed-coordinate">
								({t("chat:computerAction.executedAt", { coordinate: payload.executedCoordinate })})
							</span>
						)}
					</div>
				))}
				{shownText !== undefined && (
					<div className="flex flex-col gap-1">
						<span className="text-vscode-descriptionForeground">{t("chat:computerAction.text")}:</span>
						<pre
							className="m-0 p-2 rounded-xs bg-vscode-editor-background whitespace-pre-wrap break-all font-mono text-xs"
							data-testid="computer-action-text">
							{shownText}
						</pre>
					</div>
				)}
			</div>
		</div>
	)
})

ComputerActionRow.displayName = "ComputerActionRow"

/** Renders the `computer_action_result` say: screenshot thumbnail, active window, cursor, or window list. */
export const ComputerActionResultRow = memo(({ message }: ComputerActionRowProps) => {
	const { t } = useTranslation()
	const result = useMemo(() => parseJson<ComputerActionResult>(message.text), [message.text])

	if (!result) {
		return null
	}

	return (
		<div
			className="px-[15px] pb-[10px] pr-[6px] ml-6 flex flex-col gap-1 text-sm"
			data-testid="computer-action-result">
			{result.error && (
				<div className="text-vscode-errorForeground" data-testid="computer-action-result-error">
					{result.error}
				</div>
			)}
			{result.screenshot && (
				<div className="max-w-[360px]" data-testid="computer-action-screenshot">
					<ImageViewer
						imageUri={result.screenshot}
						alt={t("chat:computerAction.screenshotAlt")}
						showControls={true}
					/>
				</div>
			)}
			{(result.activeWindowTitle || result.cursorPosition) && (
				<div className="flex flex-wrap gap-x-3 text-xs text-vscode-descriptionForeground">
					{result.activeWindowTitle && (
						<span data-testid="computer-action-active-window">
							{t("chat:computerAction.activeWindow", { title: result.activeWindowTitle })}
						</span>
					)}
					{result.cursorPosition && (
						<span data-testid="computer-action-cursor">
							{t("chat:computerAction.cursor", { position: result.cursorPosition })}
						</span>
					)}
				</div>
			)}
			{result.windows && result.windows.length > 0 && (
				<div data-testid="computer-action-windows">
					<div className="text-xs text-vscode-descriptionForeground">
						{t("chat:computerAction.windows", { count: result.windows.length })}
					</div>
					<ul className="m-0 pl-5 text-xs">
						{result.windows.map((w) => (
							<li key={w.id} className={w.active ? "font-bold" : undefined}>
								{w.title || t("chat:computerAction.untitledWindow")}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	)
})

ComputerActionResultRow.displayName = "ComputerActionResultRow"
