import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { ExtensionMessage, MemoryBrowserRequest, MemoryBrowserState, MemoryTopic } from "@roo-code/types"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

const blank = { name: "", description: "", type: "project" as MemoryTopic["type"], body: "" }
export function MemorySettings() {
	const { t } = useTranslation()
	const [scope, setScope] = useState<"project" | "personal">("project")
	const [state, setState] = useState<MemoryBrowserState>()
	const [error, setError] = useState("")
	const [query, setQuery] = useState("")
	const [draft, setDraft] = useState(blank)
	const [editing, setEditing] = useState<MemoryTopic>()
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const projectRef = useRef<string>()
	const [loadingId, setLoadingId] = useState<string>()
	const send = (request: Omit<MemoryBrowserRequest, "scope">) => {
		setError("")
		vscode.postMessage({
			type: "memoryBrowserRequest",
			memoryBrowserRequest: {
				scope,
				projectKey: state?.projectKey,
				consentRevision: state?.consentRevision,
				...request,
			},
		})
	}
	useEffect(() => {
		const listener = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data.type !== "memoryBrowser") return
			if (event.data.memoryError) {
				setError(event.data.memoryError)
				setSaving(false)
				return
			}
			const next = event.data.memoryBrowser
			if (!next || next.scope !== scope) return
			if (projectRef.current && projectRef.current !== next.projectKey) {
				setDraft(blank)
				setEditing(undefined)
				setDirty(false)
				setSaving(false)
				setLoadingId(undefined)
			}
			projectRef.current = next.projectKey
			setState(next)
			if (next.selected && (next.selected.id === loadingId || !dirty || saving)) {
				setEditing(next.selected)
				setDraft(next.selected)
				setDirty(false)
				setSaving(false)
				setLoadingId(undefined)
			}
		}
		window.addEventListener("message", listener)
		return () => window.removeEventListener("message", listener)
	}, [scope, dirty, saving, loadingId])
	useEffect(() => {
		setState(undefined)
		setEditing(undefined)
		setDraft(blank)
		setDirty(false)
		setQuery("")
		vscode.postMessage({ type: "memoryBrowserRequest", memoryBrowserRequest: { action: "refresh", scope } })
	}, [scope])
	const inputClass = "w-full border border-vscode-panel-border rounded px-2 py-1 bg-transparent"
	return (
		<section className="space-y-3">
			<h3>{t("settings:memory.title")}</h3>
			<p className="text-sm text-vscode-descriptionForeground">{t("settings:memory.help")}</p>
			{error && <p role="alert">{error}</p>}
			{state && (
				<>
					<p className="text-xs break-all">
						{state.projectLabel}
						<br />
						{state.rootPath}
						<br />
						{state.directory}
					</p>
					<label className="flex gap-2">
						<input
							type="checkbox"
							checked={state.enabled}
							onChange={(e) =>
								send({
									action: "consent",
									enabled: e.target.checked,
									personalRecall: state.personalRecall,
								})
							}
						/>
						{t("settings:memory.enabled")}
					</label>
					<label className="flex gap-2">
						<input
							type="checkbox"
							checked={state.personalRecall}
							onChange={(e) =>
								send({ action: "consent", enabled: state.enabled, personalRecall: e.target.checked })
							}
						/>
						{t("settings:memory.personalRecall")}
					</label>
				</>
			)}
			<label className="block">
				{t("settings:memory.scope")}
				<select
					className={inputClass}
					value={scope}
					disabled={dirty}
					onChange={(e) => setScope(e.target.value as typeof scope)}>
					<option value="project">{t("settings:memory.project")}</option>
					<option value="personal">{t("settings:memory.personal")}</option>
				</select>
			</label>
			<div className="flex gap-2">
				<input
					aria-label={t("settings:memory.search")}
					className={inputClass}
					maxLength={512}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<Button variant="secondary" onClick={() => send({ action: "refresh", query })}>
					{t("settings:memory.search")}
				</Button>
			</div>
			{state?.errors.map((issue) => (
				<p key={issue} role="alert" className="text-xs">
					{issue}
				</p>
			))}
			{state && (
				<p className="text-xs">
					{t("settings:memory.count", { count: state.records.length, omitted: state.omitted })}
				</p>
			)}
			<div className="max-h-56 overflow-y-auto space-y-1">
				{state?.records.map((record) => (
					<button
						key={record.id}
						type="button"
						disabled={dirty}
						className="block w-full text-left border border-vscode-panel-border p-2 rounded disabled:opacity-50"
						onClick={() => {
							setLoadingId(record.id)
							send({ action: "read", id: record.id })
						}}>
						<strong>{record.name}</strong>
						<div className="text-xs">{record.description}</div>
						<div className="text-xs">
							{record.type} · {record.modifiedAt}
						</div>
					</button>
				))}
			</div>
			<Button
				variant="secondary"
				disabled={saving}
				onClick={() => {
					setEditing(undefined)
					setDraft(blank)
					setDirty(false)
				}}>
				{t("settings:memory.newOrDiscard")}
			</Button>
			{(["name", "description", "body"] as const).map((key) => (
				<label key={key} className="block">
					{t(`settings:memory.${key}`)}
					{key === "body" ? (
						<textarea
							disabled={saving}
							className={`${inputClass} min-h-32`}
							value={draft[key]}
							maxLength={32768}
							onChange={(e) => {
								setDraft({ ...draft, [key]: e.target.value })
								setDirty(true)
							}}
						/>
					) : (
						<input
							disabled={saving}
							className={inputClass}
							value={draft[key]}
							maxLength={key === "name" ? 160 : 512}
							onChange={(e) => {
								setDraft({ ...draft, [key]: e.target.value })
								setDirty(true)
							}}
						/>
					)}
				</label>
			))}
			<label className="block">
				{t("settings:memory.type")}
				<select
					className={inputClass}
					value={draft.type}
					onChange={(e) => {
						setDraft({ ...draft, type: e.target.value as MemoryTopic["type"] })
						setDirty(true)
					}}>
					{(["user", "feedback", "project", "reference"] as const).map((type) => (
						<option key={type} value={type}>
							{t(`settings:memory.types.${type}`)}
						</option>
					))}
				</select>
			</label>
			<div className="flex flex-wrap gap-2">
				<Button
					disabled={!state?.enabled || !dirty || saving}
					onClick={() => {
						setSaving(true)
						send({
							action: "save",
							id: editing?.id,
							expectedRevision: editing?.revision ?? null,
							input: {
								name: draft.name,
								description: draft.description,
								type: draft.type,
								body: draft.body,
							},
						})
					}}>
					{t("settings:memory.save")}
				</Button>
				{editing && (
					<>
						<Button variant="secondary" onClick={() => send({ action: "open", id: editing.id })}>
							{t("settings:memory.open")}
						</Button>
						<Button
							variant="secondary"
							onClick={() =>
								send({ action: "delete", id: editing.id, expectedRevision: editing.revision })
							}>
							{t("settings:memory.forget")}
						</Button>
					</>
				)}
				<Button
					variant="secondary"
					disabled={!state?.listRevision}
					onClick={() => send({ action: "clear", expectedRevision: state?.listRevision })}>
					{t("settings:memory.forgetAll")}
				</Button>
			</div>
			<p className="text-xs text-vscode-descriptionForeground">{t("settings:memory.forgetWarning")}</p>
		</section>
	)
}
