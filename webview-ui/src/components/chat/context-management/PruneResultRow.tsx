import { useTranslation } from "react-i18next"
import { Scissors } from "lucide-react"

import type { ContextPrune } from "@roo-code/types"

import { ContextRecoveryButton } from "./ContextRecoveryButton"
import { ReducedContentNotes } from "./ReducedContentNotes"

interface PruneResultRowProps {
	data: ContextPrune
}

/**
 * Displays an overflow recovery that pruned large older tool results without summarizing.
 */
export function PruneResultRow({ data }: PruneResultRowProps) {
	const { t } = useTranslation()
	const prevTokens = data.prevContextTokens ?? 0
	const newTokens = data.newContextTokens ?? 0

	return (
		<div className="mb-2">
			<div className="flex items-center gap-2">
				<Scissors size={16} className="text-vscode-foreground" />
				<span className="font-bold text-vscode-foreground">{t("chat:contextManagement.prune.title")}</span>
				<span className="text-vscode-descriptionForeground text-sm">
					{prevTokens.toLocaleString()} → {newTokens.toLocaleString()} {t("chat:contextManagement.tokens")}
				</span>
			</div>
			<ReducedContentNotes prunedCount={data.prunedCount} offloadedCount={data.offloadedCount} />
			<ContextRecoveryButton eventId={data.pruneId} />
		</div>
	)
}
