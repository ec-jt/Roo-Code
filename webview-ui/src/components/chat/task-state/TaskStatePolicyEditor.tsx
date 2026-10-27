import { useEffect, useState } from "react"
import { taskStatePolicySchema, type TaskStatePolicy } from "@roo-code/types"
import { actionClass, inputClass } from "./TaskStateRecords"

export const defaultTaskStatePolicy = taskStatePolicySchema.parse({})

export function TaskStatePolicyEditor({
	policy,
	disabled,
	onSave,
}: {
	policy: TaskStatePolicy
	disabled: boolean
	onSave: (policy: TaskStatePolicy) => Promise<boolean>
}) {
	const [draft, setDraft] = useState(policy)
	const [dirty, setDirty] = useState(false)
	const [error, setError] = useState("")
	useEffect(() => {
		if (!dirty) setDraft(policy)
	}, [policy, dirty])
	const update = (change: Partial<TaskStatePolicy>) => {
		setDirty(true)
		setDraft({ ...draft, ...change })
	}
	return (
		<details className="border-t border-vscode-panel-border pt-2">
			<summary className="cursor-pointer">Recall and bounded continuation policy</summary>
			<p>
				Continuation is off by default. Saving policy requires native review and resets counters and user
				attestations. Checks are descriptions only: no shell execution or automated verification.
			</p>
			<fieldset disabled={disabled} className="space-y-2 min-w-0">
				<label className="block">
					<input
						type="checkbox"
						checked={draft.recallEnabled}
						onChange={(e) => update({ recallEnabled: e.target.checked })}
					/>{" "}
					Recall task data to the provider
				</label>
				<label className="block">
					<input
						type="checkbox"
						checked={draft.enabled}
						onChange={(e) => update({ enabled: e.target.checked })}
					/>{" "}
					Enable bounded continuation
				</label>
				{(
					[
						["maxSteps", "Maximum steps"],
						["maxDurationMs", "Maximum duration (milliseconds)"],
						["maxTokens", "Maximum tokens"],
						["maxNoProgressSteps", "Maximum no-progress steps"],
					] as const
				).map(([field, label]) => (
					<label key={field} className="block">
						{label}
						<input
							className={inputClass}
							type="number"
							min={1}
							step={1}
							value={Number.isNaN(draft[field]) ? "" : draft[field]}
							onChange={(e) => update({ [field]: e.target.valueAsNumber })}
						/>
					</label>
				))}
				{draft.checks.map((check, index) => (
					<div key={index} className="space-y-1 border border-vscode-panel-border p-2">
						<label className="block">
							Check {index + 1} ID
							<input
								className={inputClass}
								value={check.id}
								onChange={(e) =>
									update({
										checks: draft.checks.map((c, i) =>
											i === index ? { ...c, id: e.target.value } : c,
										),
									})
								}
							/>
						</label>
						<label className="block">
							Check {index + 1} description
							<textarea
								className={inputClass}
								value={check.text}
								onChange={(e) =>
									update({
										checks: draft.checks.map((c, i) =>
											i === index ? { ...c, text: e.target.value } : c,
										),
									})
								}
							/>
						</label>
						<button
							type="button"
							className={actionClass}
							onClick={() => update({ checks: draft.checks.filter((_, i) => i !== index) })}>
							Remove check {index + 1}
						</button>
					</div>
				))}
				<button
					type="button"
					className={actionClass}
					onClick={() =>
						update({ checks: [...draft.checks, { id: `check-${crypto.randomUUID()}`, text: "" }] })
					}>
					Add acceptance check
				</button>
				{error && <p role="alert">{error}</p>}
				<button
					type="button"
					className={actionClass}
					onClick={async () => {
						const result = taskStatePolicySchema.safeParse(draft)
						if (!result.success) {
							setError(
								result.error.issues
									.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
									.join("; "),
							)
							return
						}
						if (draft.enabled && !draft.checks.length) {
							setError("Enabled continuation requires at least one user-attested check.")
							return
						}
						if (
							draft.checks.some((c) => !c.text.trim()) ||
							new Set(draft.checks.map((c) => c.id)).size !== draft.checks.length
						) {
							setError("Check descriptions must be nonempty and check IDs unique.")
							return
						}
						setError("")
						if (await onSave(result.data)) setDirty(false)
					}}>
					Review and save policy
				</button>
			</fieldset>
		</details>
	)
}
