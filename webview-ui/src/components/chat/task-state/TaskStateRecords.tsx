import { useState } from "react"
import { taskStatePatchOperationSchema, type TaskStateData, type TaskStatePatchOperation } from "@roo-code/types"

export const inputClass =
	"w-full rounded border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground p-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
export const actionClass =
	"rounded border border-vscode-input-border px-2 py-1 bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground disabled:opacity-40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
const collections = {
	acceptanceCriteria: "Acceptance criteria",
	constraints: "Constraints",
	decisions: "Decisions",
	failedApproaches: "Failed approaches",
	blockers: "Blockers",
	workItems: "Work items (CLAIMED)",
	evidenceRefs: "Evidence references",
} as const
type Collection = keyof typeof collections

export function TaskStateRecords({
	data,
	onOperation,
	disabled,
}: {
	data: TaskStateData
	onOperation: (operation: TaskStatePatchOperation) => void
	disabled: boolean
}) {
	const [collection, setCollection] = useState<Collection>("acceptanceCriteria")
	const [id, setId] = useState("")
	const [text, setText] = useState("")
	const [status, setStatus] = useState<TaskStateData["workItems"][number]["status"]>("pending")
	const [evidenceIds, setEvidenceIds] = useState("")
	const [source, setSource] = useState("")
	const [error, setError] = useState("")
	const reset = () => {
		setId("")
		setText("")
		setStatus("pending")
		setEvidenceIds("")
		setSource("")
		setError("")
	}
	const add = () => {
		const value =
			collection === "workItems"
				? {
						id,
						text,
						status,
						evidenceIds: evidenceIds
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean),
					}
				: collection === "evidenceRefs"
					? { id, text, source }
					: { id, text }
		const result = taskStatePatchOperationSchema.safeParse({ op: "upsert", collection, value })
		if (!result.success) {
			setError(result.error.issues.map((issue) => issue.message).join("; "))
			return
		}
		onOperation(result.data)
		reset()
	}
	return (
		<details className="border-t border-vscode-panel-border pt-2">
			<summary className="cursor-pointer">Records and evidence</summary>
			<p>
				Work-item statuses, including “verified”, are CLAIMED. Runtime observations are receipts, not
				verification. Runtime evidence cannot be edited or removed here.
			</p>
			<fieldset disabled={disabled} className="space-y-2 min-w-0">
				<label className="block">
					Record collection
					<select
						className={inputClass}
						value={collection}
						onChange={(e) => {
							setCollection(e.target.value as Collection)
							reset()
						}}>
						{Object.entries(collections).map(([value, label]) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
				</label>
				<ul className="list-none p-0 space-y-2">
					{data[collection].map((record) => {
						const runtime = "provenance" in record && record.provenance === "runtime_observed"
						return (
							<li key={record.id} className="border border-vscode-panel-border rounded p-2 break-words">
								<strong>{record.id}</strong>: {record.text}
								{"status" in record && (
									<p>
										CLAIMED: {record.status}; evidence: {record.evidenceIds.join(", ") || "none"}
									</p>
								)}
								{"provenance" in record && (
									<p>
										{record.provenance}: {record.source}
										{record.observedAt ? ` (${record.observedAt})` : ""}
									</p>
								)}
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										className={actionClass}
										disabled={runtime}
										aria-label={`Edit ${record.id}`}
										onClick={() => {
											setId(record.id)
											setText(record.text)
											if ("status" in record) {
												setStatus(record.status)
												setEvidenceIds(record.evidenceIds.join(", "))
											}
											if ("source" in record) setSource(record.source)
										}}>
										Edit
									</button>
									<button
										type="button"
										className={actionClass}
										disabled={runtime}
										aria-label={`Remove ${record.id}`}
										onClick={() => onOperation({ op: "remove", collection, id: record.id })}>
										Remove from draft
									</button>
								</div>
							</li>
						)
					})}
				</ul>
				<label className="block">
					Record ID
					<input className={inputClass} value={id} onChange={(e) => setId(e.target.value)} maxLength={100} />
				</label>
				<label className="block">
					Record text
					<textarea
						className={inputClass}
						value={text}
						onChange={(e) => setText(e.target.value)}
						maxLength={8000}
					/>
				</label>
				{collection === "workItems" && (
					<>
						<label className="block">
							Claimed status
							<select
								className={inputClass}
								value={status}
								onChange={(e) => setStatus(e.target.value as typeof status)}>
								{["pending", "in_progress", "blocked", "implemented", "verified"].map((s) => (
									<option key={s}>{s}</option>
								))}
							</select>
						</label>
						<label className="block">
							Evidence IDs (comma separated)
							<input
								className={inputClass}
								value={evidenceIds}
								onChange={(e) => setEvidenceIds(e.target.value)}
							/>
						</label>
					</>
				)}
				{collection === "evidenceRefs" && (
					<label className="block">
						Evidence source
						<input
							className={inputClass}
							value={source}
							onChange={(e) => setSource(e.target.value)}
							maxLength={8000}
						/>
					</label>
				)}
				{error && <p role="alert">{error}</p>}
				<button type="button" className={actionClass} onClick={add}>
					Add or update draft record
				</button>
			</fieldset>
		</details>
	)
}
