import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { RunningTaskInfo } from "@roo-code/types"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"
import { CommandActivityList } from "./CommandActivityList"
import { ChevronDown, ChevronRight } from "lucide-react"

export function RunningTaskMonitor({ visible = true }: { visible?: boolean }) {
	const { runningTask, commandActivities = [] } = useExtensionState()
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState(false)
	const activeCount = commandActivities.filter((a) => a.status === "running" || a.status === "stopping").length
	if (!runningTask && commandActivities.length === 0) return null
	return (
		<section
			aria-label={t("chat:backgroundActivity.title")}
			className="shrink-0 border-t border-vscode-panel-border text-xs">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((value) => !value)}
				className="flex items-center gap-2 w-full px-4 py-1.5 text-left cursor-pointer text-vscode-descriptionForeground hover:text-vscode-foreground">
				{expanded ? (
					<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
				) : (
					<ChevronRight className="size-3 shrink-0" aria-hidden="true" />
				)}
				<span
					className="truncate flex-1"
					title={t("chat:backgroundActivity.commands", {
						active: activeCount,
						total: commandActivities.length,
					})}>
					{t("chat:backgroundActivity.title")} ({activeCount}/{commandActivities.length})
				</span>
				{runningTask && <span className="shrink-0">{t(`chat:runningTask.status.${runningTask.status}`)}</span>}
			</button>
			{expanded && (
				<div className="max-h-[35vh] overflow-y-auto">
					{runningTask && <RunningTaskCard task={runningTask} visible={visible} />}
					<CommandActivityList activities={commandActivities} visible={visible} embedded />
				</div>
			)}
		</section>
	)
}

export function RunningTaskCard({ task, visible = true }: { task: RunningTaskInfo; visible?: boolean }) {
	const { t } = useTranslation()
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		if (!visible || task.stoppedAt !== undefined) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [task.instanceId, task.stoppedAt, visible])
	const seconds = Math.max(0, Math.floor(((task.stoppedAt ?? now) - task.startedAt) / 1000))
	const elapsed = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
		.map((part) => String(part).padStart(2, "0"))
		.join(":")
	const control = (type: "backgroundTask" | "foregroundTask" | "cancelBackgroundTask") =>
		vscode.postMessage({ type, taskId: task.taskId, instanceId: task.instanceId })
	return (
		<section
			aria-label={t("chat:runningTask.title")}
			className="shrink-0 border-b border-vscode-panel-border px-4 py-2 text-xs">
			<div className="flex items-center justify-between gap-2">
				<strong>{t("chat:runningTask.title")}</strong>
				<span title={t("chat:runningTask.timerHelp")} className="tabular-nums">
					{elapsed}
				</span>
			</div>
			<div title={task.title} className="truncate my-1">
				{task.title}
			</div>
			<div className="flex items-center justify-between flex-wrap gap-2">
				<span role="status">{t(`chat:runningTask.status.${task.status}`)}</span>
				<div className="flex gap-2">
					{task.background ? (
						<>
							<Button size="sm" onClick={() => control("foregroundTask")}>
								{t("chat:runningTask.return")}
							</Button>
							{task.stoppedAt === undefined && (
								<Button size="sm" variant="secondary" onClick={() => control("cancelBackgroundTask")}>
									{t("chat:runningTask.cancel")}
								</Button>
							)}
						</>
					) : (
						task.stoppedAt === undefined && (
							<Button size="sm" variant="secondary" onClick={() => control("backgroundTask")}>
								{t("chat:runningTask.background")}
							</Button>
						)
					)}
				</div>
			</div>
			{task.background && (
				<p className="mb-0 mt-2 text-vscode-descriptionForeground">{t("chat:runningTask.notice")}</p>
			)}
		</section>
	)
}
