import { useEffect, useId, useMemo, useState } from "react"
import type { TaskStateData, TaskStatePatchOperation } from "@roo-code/types"
import { useTaskState } from "@src/hooks/useTaskState"
import { actionClass, inputClass, TaskStateRecords } from "./TaskStateRecords"
import { defaultTaskStatePolicy, TaskStatePolicyEditor } from "./TaskStatePolicyEditor"

const emptyData: TaskStateData = {
	goal: "",
	nextAction: "",
	acceptanceCriteria: [],
	constraints: [],
	decisions: [],
	failedApproaches: [],
	blockers: [],
	workItems: [],
	evidenceRefs: [],
}

function previewOperations(data: TaskStateData, operations: TaskStatePatchOperation[]): TaskStateData {
	const next = structuredClone(data)
	for (const operation of operations) {
		if (operation.op === "set") {
			next[operation.field] = operation.value
			continue
		}
		if (operation.op === "remove") {
			// The collection discriminant and its record type remain paired.
			Object.assign(next, {
				[operation.collection]: next[operation.collection].filter((r) => r.id !== operation.id),
			})
		} else {
			const record =
				operation.collection === "evidenceRefs"
					? { ...operation.value, provenance: "user_claim" }
					: operation.value
			Object.assign(next, {
				[operation.collection]: [...next[operation.collection].filter((r) => r.id !== record.id), record],
			})
		}
	}
	return next
}

/** The keyed boundary discards drafts and pending replies when the current task changes. */
export function TaskStatePanel({ taskId }: { taskId: string }) {
	return <TaskStatePanelForTask key={taskId} taskId={taskId} />
}

function TaskStatePanelForTask({ taskId }: { taskId: string }) {
	const [open, setOpen] = useState(false)
	const [visited, setVisited] = useState(false)
	const panelId = useId()
	return (
		<section className="shrink-0 border-b border-vscode-panel-border px-3 py-1" aria-label="Task state">
			<button
				type="button"
				className={actionClass}
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => {
					setVisited(true)
					setOpen(!open)
				}}>
				Task state
			</button>
			{/* Keep drafts when collapsed. The task-keyed boundary clears them on a task switch. */}
			<div id={panelId} hidden={!open}>
				{visited && <TaskStateEditor taskId={taskId} />}
			</div>
		</section>
	)
}

export function TaskStateEditor({ taskId }: { taskId: string }) {
	const { response, error, busy, needsRefresh, request } = useTaskState(taskId)
	const [goal, setGoal] = useState<string>()
	const [nextAction, setNextAction] = useState<string>()
	const [operations, setOperations] = useState<TaskStatePatchOperation[]>([])
	const [reviewedCoverage, setReviewedCoverage] = useState<string>()
	const [notice, setNotice] = useState("")
	const [exportText, setExportText] = useState<string>()
	const [checkId, setCheckId] = useState("")
	const [checkResult, setCheckResult] = useState<"passed" | "failed">("passed")
	const [checkNote, setCheckNote] = useState("")
	const [sourceTask, setSourceTask] = useState("")
	const [sourceRevision, setSourceRevision] = useState("")
	useEffect(() => {
		void request({ action: "read" })
	}, [request])
	const snapshot = response?.snapshot
	const data = snapshot?.data ?? emptyData
	const policy = response?.policy ?? snapshot?.policy ?? defaultTaskStatePolicy
	const draftData = useMemo(() => previewOperations(data, operations), [data, operations])
	const loaded = response?.revision !== undefined
	const absent = loaded && response.revision === null
	const incompatible = loaded && response.revision !== null && !snapshot
	const dirty = goal !== undefined || nextAction !== undefined || operations.length > 0
	const disabled = busy || !loaded || needsRefresh
	const coverageKey = `${response?.revision}:${response?.history?.anchor}:${response?.history?.position}`
	const currentCoverage =
		!!snapshot &&
		snapshot.historyAnchor === response?.history?.anchor &&
		snapshot.historyPosition === response?.history?.position
	const save = async () => {
		const patch: TaskStatePatchOperation[] = [...operations]
		if (goal !== undefined || absent) patch.push({ op: "set", field: "goal", value: goal ?? data.goal })
		// Saving an unchanged next action explicitly reviews current history coverage.
		patch.push({ op: "set", field: "nextAction", value: nextAction ?? data.nextAction })
		const result = await request({ action: absent ? "initialize" : "correct", operations: patch })
		if (!result) return
		setGoal(undefined)
		setNextAction(undefined)
		setOperations([])
		setReviewedCoverage(`${result.revision}:${result.history?.anchor}:${result.history?.position}`)
		setNotice("Reviewed state saved. Native confirmation approved this exact change.")
	}
	const refresh = async () => {
		setReviewedCoverage(undefined)
		const result = await request({ action: "read" })
		if (result)
			setNotice(
				dirty
					? "Refreshed. Your draft is retained. Compare it with the stored state before retrying."
					: "Task state refreshed.",
			)
	}
	return (
		<div className="max-h-[55vh] overflow-y-auto space-y-3 py-2 text-sm" aria-label="Task-state editor">
			<p>
				Task-local memory is opt-in. Recalled data is sent to your provider. Do not store credentials or
				secrets.
			</p>
			<p>
				Changes require the current task to be idle and native confirmation. If busy, stop the task and reopen
				it from History without resuming to review. Refresh to see current runtime status.
			</p>
			<div className="flex flex-wrap gap-2">
				<button type="button" className={actionClass} disabled={busy} onClick={refresh}>
					Refresh task state
				</button>
				<button
					type="button"
					className={actionClass}
					onClick={async () => {
						setReviewedCoverage(undefined)
						await request({ action: "stop" })
					}}>
					Stop continuation
				</button>
				<button
					type="button"
					className={actionClass}
					disabled={busy || !loaded}
					onClick={async () => {
						const result = await request({ action: "export" })
						if (result?.exportText !== undefined) setExportText(result.exportText)
					}}>
					Export Markdown
				</button>
			</div>
			<p>Stop revokes continuation immediately. It does not interrupt an in-flight tool or provider request.</p>
			{busy && <p role="status">Waiting for the extension. Check for a native review dialog.</p>}
			{error && (
				<p role="alert" className="break-words">
					{error} Your draft is retained.
				</p>
			)}
			{needsRefresh && (
				<p role="alert">
					Refresh is required before another change. Review the latest stored state; nothing will be
					overwritten automatically.
				</p>
			)}
			{notice && <p role="status">{notice}</p>}
			{absent && (
				<p>Task state is off. No ledger exists. Only “Enable task state” or an explicit fork creates one.</p>
			)}
			{incompatible && (
				<p role="alert">
					Incompatible history: a ledger exists, but no snapshot matches this history. Do not initialize
					again. A reviewed correction or policy change rebases from empty state at the current history; old
					revisions are retained, not imported.
				</p>
			)}
			{loaded && (
				<details>
					<summary className="cursor-pointer">Stored revision and history coverage</summary>
					<dl className="break-all">
						<dt>Ledger head (write revision)</dt>
						<dd>{response.revision ?? "No ledger"}</dd>
						<dt>Selected snapshot revision</dt>
						<dd>{snapshot?.revision ?? "None"}</dd>
						<dt>Snapshot coverage</dt>
						<dd>
							{snapshot?.historyPosition ?? "Unknown"} original messages; anchor{" "}
							{snapshot?.historyAnchor ?? "None"}
						</dd>
						<dt>Current history coverage</dt>
						<dd>
							{response.history?.position ?? "Unknown"} original messages; anchor{" "}
							{response.history?.anchor ?? "Unknown"}
						</dd>
					</dl>
					<p>
						{currentCoverage
							? "Snapshot covers current history."
							: "Snapshot does not cover current history. Review and save before fresh context."}
					</p>
					{dirty && (
						<>
							<p>Stored goal: {data.goal || "(empty)"}</p>
							<p>Stored next action: {data.nextAction || "(empty)"}</p>
							<pre className="whitespace-pre-wrap break-words">{JSON.stringify(data, null, 2)}</pre>
						</>
					)}
				</details>
			)}
			<fieldset disabled={busy || !loaded} className="space-y-2 min-w-0">
				<label className="block">
					Goal
					<textarea
						className={inputClass}
						value={goal ?? data.goal}
						onChange={(e) => setGoal(e.target.value)}
						maxLength={8000}
					/>
				</label>
				<label className="block">
					Next action
					<textarea
						className={inputClass}
						value={nextAction ?? data.nextAction}
						onChange={(e) => setNextAction(e.target.value)}
						maxLength={8000}
					/>
				</label>
				<TaskStateRecords
					data={draftData}
					disabled={busy || !loaded}
					onOperation={(operation) => {
						setOperations([...operations, operation])
						setReviewedCoverage(undefined)
					}}
				/>
				<p>
					{operations.length} queued record changes. Drafts are not saved until you approve the native review.
				</p>
				<button type="button" className={actionClass} disabled={disabled} onClick={save}>
					{absent ? "Enable task state" : "Review and save state"}
				</button>
				{dirty && (
					<button
						type="button"
						className={actionClass}
						onClick={() => {
							setGoal(undefined)
							setNextAction(undefined)
							setOperations([])
							setReviewedCoverage(undefined)
						}}>
						Discard draft
					</button>
				)}
			</fieldset>
			{loaded && !absent && (
				<>
					<TaskStatePolicyEditor
						policy={policy}
						disabled={disabled}
						onSave={async (newPolicy) => {
							setReviewedCoverage(undefined)
							return !!(await request({ action: "configure", policy: newPolicy }))
						}}
					/>
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							className={actionClass}
							disabled={disabled || !snapshot || !policy.enabled || !policy.recallEnabled || dirty}
							onClick={() => request({ action: "start" })}>
							Arm next ordinary turn
						</button>
						<button
							type="button"
							className={actionClass}
							disabled={disabled}
							onClick={() => request({ action: "disable" })}>
							Disable recall and continuation
						</button>
					</div>
					<p>
						Arming does not dispatch work. Send an ordinary message to begin. Tool approvals remain
						mandatory. Disable retains stored data.
					</p>
					<details className="border-t border-vscode-panel-border pt-2">
						<summary className="cursor-pointer">Reviewed fresh context</summary>
						<p>
							This excludes the prior transcript from future provider context. It does not summarize that
							transcript. Original messages remain stored. First review and save state to cover current
							history, even if the next action is unchanged.
						</p>
						<button
							type="button"
							className={actionClass}
							disabled={disabled || dirty || !currentCoverage || reviewedCoverage !== coverageKey}
							onClick={async () => {
								const result = await request({ action: "fresh-context" })
								if (result) {
									setReviewedCoverage(undefined)
									setNotice("Reviewed fresh context created. No work was dispatched.")
								}
							}}>
							Review and create fresh context
						</button>
					</details>
					<details className="border-t border-vscode-panel-border pt-2">
						<summary className="cursor-pointer">Record user check result</summary>
						<p>
							These are user-attested results, not automated tests. No shell commands execute. Work-item
							“verified” claims do not establish completion.
						</p>
						<fieldset disabled={disabled || !policy.checks.length} className="space-y-2 min-w-0">
							<label className="block">
								Acceptance check
								<select
									className={inputClass}
									value={checkId}
									onChange={(e) => setCheckId(e.target.value)}>
									<option value="">Choose a check</option>
									{policy.checks.map((check) => (
										<option key={check.id} value={check.id}>
											{check.id}: {check.text}
										</option>
									))}
								</select>
							</label>
							<label className="block">
								User result
								<select
									className={inputClass}
									value={checkResult}
									onChange={(e) => setCheckResult(e.target.value as typeof checkResult)}>
									<option value="passed">Passed</option>
									<option value="failed">Failed</option>
								</select>
							</label>
							<label className="block">
								Result note
								<textarea
									className={inputClass}
									value={checkNote}
									onChange={(e) => setCheckNote(e.target.value)}
									maxLength={8000}
								/>
							</label>
							<button
								type="button"
								className={actionClass}
								disabled={!policy.checks.some((c) => c.id === checkId) || !checkNote.trim()}
								onClick={async () => {
									if (
										await request({
											action: "attest",
											check: { id: checkId, result: checkResult, note: checkNote },
										})
									)
										setCheckNote("")
								}}>
								Review user check result
							</button>
						</fieldset>
					</details>
				</>
			)}
			{response?.runtime && (
				<section aria-label="Continuation status" className="border border-vscode-panel-border p-2 break-words">
					<h3 className="font-semibold">Continuation: {response.runtime.armed ? "armed" : "not armed"}</h3>
					<p>
						Status: {response.runtime.status} (completion uses user attestations, not automated
						verification)
					</p>
					<p>Reason: {response.runtime.reason || "None"}</p>
					<p>
						Steps: {response.runtime.steps} / {policy.maxSteps}; tokens: {response.runtime.tokens} /{" "}
						{policy.maxTokens}; elapsed: {response.runtime.elapsedMs} / {policy.maxDurationMs} ms; no
						progress: {response.runtime.noProgressSteps} / {policy.maxNoProgressSteps}
					</p>
					<ul>
						{response.runtime.checks.map((check) => (
							<li key={check.id}>
								{check.id}: {check.result} (user-attested). {check.note}
							</li>
						))}
					</ul>
				</section>
			)}
			{absent && (
				<details>
					<summary className="cursor-pointer">Fork reviewed state from another task</summary>
					<p>
						Only a source in this workspace is allowed. Enter its exact selected snapshot revision, not
						merely its ledger head. The destination must not already have a ledger.
					</p>
					<label className="block">
						Source task ID
						<input
							className={inputClass}
							value={sourceTask}
							onChange={(e) => setSourceTask(e.target.value)}
						/>
					</label>
					<label className="block">
						Source snapshot revision
						<input
							className={inputClass}
							value={sourceRevision}
							onChange={(e) => setSourceRevision(e.target.value)}
						/>
					</label>
					<button
						type="button"
						className={actionClass}
						disabled={disabled || dirty || !sourceTask || !/^[a-f0-9]{64}$/.test(sourceRevision)}
						onClick={() =>
							request({ action: "fork", source: { taskId: sourceTask, revision: sourceRevision } })
						}>
						Review and fork task state
					</button>
				</details>
			)}
			{exportText !== undefined && (
				<label className="block">
					Markdown export (read-only; select to copy)
					<textarea
						className={`${inputClass} min-h-40 font-mono`}
						readOnly
						value={exportText}
						onFocus={(e) => e.target.select()}
					/>
				</label>
			)}
			<p className="text-vscode-descriptionForeground">
				Limits: 24,000 recall characters; 200 ledger revisions; 4 MiB ledger. Capacity and validation errors are
				shown here, not silently discarded.
			</p>
		</div>
	)
}
