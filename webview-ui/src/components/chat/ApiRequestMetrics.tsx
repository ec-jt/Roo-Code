import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import type { ClineApiReqInfo } from "@roo-code/types"

export function ApiRequestMetrics({ info, active }: { info?: ClineApiReqInfo; active: boolean }) {
	const { t } = useTranslation()
	const [now, setNow] = useState(Date.now)
	const timing = info?.timing
	const running = active && timing !== undefined && timing.completedAt === undefined
	useEffect(() => {
		if (!running) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [running, timing?.startedAt])
	if (!info) return null
	const seconds = (start: number, end: number) => (Math.max(0, end - start) / 1000).toFixed(1)
	const end = timing?.completedAt ?? (active ? now : undefined)
	const reads = info.cacheReads ?? 0
	const writes = info.cacheWrites ?? 0
	// Older histories stored zero even when the provider supplied no cache data.
	const reported = info.cacheReadTokensReported === true || reads > 0
	const hitPercent = info.tokensIn && info.tokensIn >= reads ? Math.round((reads / info.tokensIn) * 100) : undefined

	return (
		<div className="text-xs text-vscode-descriptionForeground mt-1 flex flex-col gap-1">
			{timing && end !== undefined && (
				<div title={t("chat:apiRequest.metrics.timingHelp")}>
					{t("chat:apiRequest.metrics.preparation", {
						seconds: seconds(timing.startedAt, timing.providerStartedAt ?? end),
					})}
					{timing.providerStartedAt !== undefined && (
						<>
							{" "}
							·{" "}
							{t("chat:apiRequest.metrics.firstChunk", {
								seconds: seconds(timing.providerStartedAt, timing.firstChunkAt ?? end),
							})}
						</>
					)}
					{running && (
						<>
							{" "}
							·{" "}
							{t(
								`chat:apiRequest.metrics.${timing.firstChunkAt !== undefined ? "streaming" : timing.providerStartedAt !== undefined ? "waiting" : "preparing"}`,
							)}
						</>
					)}
				</div>
			)}
			{reported || writes > 0 ? (
				<div title={t("chat:apiRequest.metrics.expiryUnknown")}>
					{reported && t("chat:apiRequest.metrics.cacheRead", { tokens: reads.toLocaleString() })}
					{reported && hitPercent !== undefined && ` (${hitPercent}%)`}
					{writes > 0 && (
						<>
							{reported && " · "}
							{t("chat:apiRequest.metrics.cacheWrite", { tokens: writes.toLocaleString() })}
						</>
					)}
					<div>{t("chat:apiRequest.metrics.expiryUnknown")}</div>
				</div>
			) : (
				!active && <div>{t("chat:apiRequest.metrics.cacheUnknown")}</div>
			)}
		</div>
	)
}
