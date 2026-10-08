import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { CommandActivityInfo } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

export function CommandActivityList({
	activities,
	visible,
	embedded = false,
}: {
	activities: CommandActivityInfo[]
	visible: boolean
	embedded?: boolean
}) {
	const { t } = useTranslation()
	const [open, setOpen] = useState(false)
	const [now, setNow] = useState(Date.now)
	const activeCount = activities.filter((a) => a.status === "running" || a.status === "stopping").length
	useEffect(() => {
		if (!visible || (!open && !embedded) || !activeCount) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [visible, open, embedded, activeCount])
	const content = (
		<>
			<p className="text-vscode-descriptionForeground">{t("chat:backgroundActivity.limitations")}</p>
			<div className={embedded ? "space-y-2" : "max-h-64 overflow-y-auto space-y-2"}>
				{activities.length === 0 && <p>{t("chat:backgroundActivity.empty")}</p>}
				{activities.map((activity) => {
					const seconds = Math.max(0, Math.floor(((activity.endedAt ?? now) - activity.startedAt) / 1000))
					return (
						<article key={activity.id} className="border border-vscode-panel-border rounded p-2 space-y-1">
							<div className="flex justify-between gap-2 flex-wrap">
								<strong>{t(`chat:backgroundActivity.status.${activity.status}`)}</strong>
								{(activity.endedAt !== undefined ||
									activity.status === "running" ||
									activity.status === "stopping") && (
									<span className="tabular-nums">
										{t("chat:backgroundActivity.elapsed", { seconds })}
									</span>
								)}
							</div>
							<pre className="whitespace-pre-wrap break-all m-0">{activity.command}</pre>
							<div className="break-all text-vscode-descriptionForeground">{activity.cwd}</div>
							<div className="break-all">
								{t("chat:backgroundActivity.owner", {
									task: activity.taskId ?? t("chat:backgroundActivity.unassigned"),
									terminal: activity.terminalId,
								})}
							</div>
							{activity.exitCode !== undefined && (
								<div>{t("chat:backgroundActivity.exit", { code: activity.exitCode })}</div>
							)}
							<div className="flex gap-2">
								{activity.canShowTerminal && (
									<Button
										size="sm"
										variant="secondary"
										onClick={() =>
											vscode.postMessage({
												type: "commandActivityControl",
												commandActivityControl: { id: activity.id, action: "show" },
											})
										}>
										{t("chat:backgroundActivity.show")}
									</Button>
								)}
								{activity.canStop && (
									<Button
										size="sm"
										variant="secondary"
										onClick={() =>
											vscode.postMessage({
												type: "commandActivityControl",
												commandActivityControl: { id: activity.id, action: "stop" },
											})
										}>
										{t("chat:backgroundActivity.stop")}
									</Button>
								)}
							</div>
							<details>
								<summary className="cursor-pointer">{t("chat:backgroundActivity.output")}</summary>
								<pre className="whitespace-pre-wrap break-all max-h-40 overflow-auto">
									{activity.outputTail || t("chat:backgroundActivity.noOutput")}
								</pre>
							</details>
						</article>
					)
				})}
			</div>
		</>
	)
	if (embedded) return <div className="px-4 py-2">{content}</div>
	return (
		<details
			open={open}
			onToggle={(e) => setOpen(e.currentTarget.open)}
			className="border-b border-vscode-panel-border px-4 py-2 text-xs shrink-0">
			<summary className="cursor-pointer font-semibold">
				{t("chat:backgroundActivity.commands", { active: activeCount, total: activities.length })}
			</summary>
			{content}
		</details>
	)
}
