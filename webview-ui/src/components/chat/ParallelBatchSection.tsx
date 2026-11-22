import { useTranslation } from "react-i18next"
import type { ParallelBatchInfo } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

/**
 * Background activity: children of the current task's parallel batch (ADR-2026-11-22-parallel-subtasks
 * rule 6). Stop and Stop all go to ParallelTaskPool.stopChild / stopBatch. Open shows the child's
 * messages read-only in a native editor document.
 */
export function ParallelBatchSection({ batch }: { batch: ParallelBatchInfo }) {
	const { t } = useTranslation()
	const control = (action: "stop" | "stopAll" | "open", taskId?: string) =>
		vscode.postMessage({
			type: "parallelBatchControl",
			parallelBatchControl: { batchId: batch.batchId, action, ...(taskId ? { taskId } : {}) },
		})
	return (
		<section
			aria-label={t("chat:parallelSubtasks.title")}
			className="border-b border-vscode-panel-border px-4 py-2 text-xs"
			data-testid="parallel-batch-section">
			<div className="flex items-center justify-between gap-2">
				<strong>{t("chat:parallelSubtasks.title")}</strong>
				{batch.running && (
					<Button size="sm" variant="secondary" onClick={() => control("stopAll")}>
						{t("chat:parallelSubtasks.stopAll")}
					</Button>
				)}
			</div>
			<div className="text-vscode-descriptionForeground my-1">
				{t("chat:parallelSubtasks.budget", {
					used: batch.usedTokens.toLocaleString(),
					budget: batch.tokenBudget.toLocaleString(),
					concurrency: batch.concurrency,
				})}
			</div>
			<ul className="list-none p-0 m-0 flex flex-col gap-2">
				{batch.children.map((child) => (
					<li key={child.taskId} className="flex flex-col gap-1" data-testid="parallel-child">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate">
								<code>{child.mode}</code>{" "}
								<span role="status">{t(`chat:parallelSubtasks.status.${child.status}`)}</span>
							</span>
							<div className="flex gap-2 shrink-0">
								<Button size="sm" variant="secondary" onClick={() => control("open", child.taskId)}>
									{t("chat:parallelSubtasks.open")}
								</Button>
								{child.status === "running" && (
									<Button size="sm" variant="secondary" onClick={() => control("stop", child.taskId)}>
										{t("chat:parallelSubtasks.stop")}
									</Button>
								)}
							</div>
						</div>
						<div className="text-vscode-descriptionForeground truncate" title={child.branch}>
							{t("chat:parallelSubtasks.details", {
								requests: child.requests,
								cost: child.cost.toFixed(4),
								branch: child.branch,
							})}
						</div>
					</li>
				))}
			</ul>
		</section>
	)
}
