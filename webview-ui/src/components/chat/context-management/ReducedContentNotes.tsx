import { useTranslation } from "react-i18next"

interface ReducedContentNotesProps {
	prunedCount?: number
	offloadedCount?: number
}

/**
 * Lists the tool results pruned and images offloaded during overflow recovery.
 * Used by the prune, condense and truncation rows, so the counts stay visible when a
 * summary or truncation still followed the prune/offload step.
 */
export function ReducedContentNotes({ prunedCount, offloadedCount }: ReducedContentNotesProps) {
	const { t } = useTranslation()
	const pruned = prunedCount ?? 0
	const offloaded = offloadedCount ?? 0
	return (
		<>
			{pruned > 0 && (
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("chat:contextManagement.prune.description", { count: pruned })}
				</p>
			)}
			{offloaded > 0 && (
				<p className="text-xs text-vscode-descriptionForeground mt-1">
					{t("chat:contextManagement.prune.offloaded", { count: offloaded })}
				</p>
			)}
		</>
	)
}
