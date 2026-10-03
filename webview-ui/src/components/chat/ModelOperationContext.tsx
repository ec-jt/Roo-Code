import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import type { ClineMessage, ModelOperation, ModelOperationState, ModelOperationStatus } from "@roo-code/types"
import { modelOperationStatusSchema } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@src/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@src/components/ui/select"

type Identity = Pick<ModelOperationState, "taskId" | "instanceId" | "revision">
type Selection = { source: ModelOperationState; kind: ModelOperation["kind"]; requestId?: string; profileId: string }
type Pending = { operationId: string; source: Identity; approval?: boolean }

const sameInstance = (a: Identity | undefined, b: Partial<Identity> | undefined) =>
	!!a && !!b && a.taskId === b.taskId && a.instanceId === b.instanceId
const sameRevision = (a: Identity | undefined, b: Partial<Identity> | undefined) =>
	sameInstance(a, b) && a?.revision === b?.revision

interface ModelOperationControls {
	open: (kind: ModelOperation["kind"], requestId?: string, profileId?: string) => void
	busy: boolean
	panel: ReactNode
}

const ModelOperationContext = createContext<ModelOperationControls | undefined>(undefined)
export const useModelOperation = () => useContext(ModelOperationContext)
export const ModelOperationPanel = () => <>{useModelOperation()?.panel}</>

export function ModelOperationProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation()
	const { modelOperation: state, listApiConfigMeta: profiles = [], currentApiConfigName } = useExtensionState()
	const [selection, setSelection] = useState<Selection>()
	const [confirmed, setConfirmed] = useState(false)
	const [pending, setPending] = useState<Pending>()
	const pendingRef = useRef<Pending>()
	const [outcome, setOutcome] = useState<{ status: ModelOperationStatus; source: Identity; approval?: boolean }>()
	const [answeredApproval, setAnsweredApproval] = useState<string>()
	const stateRef = useRef(state)
	stateRef.current = state

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type !== "modelOperationStatus") return
			const parsed = modelOperationStatusSchema.safeParse(event.data.modelOperationStatus)
			const action = pendingRef.current
			const current = stateRef.current
			if (!parsed.success || !action || parsed.data.operationId !== action.operationId) return
			const status = parsed.data
			// Completion identifies the new branch, not the source. State and status can arrive in either order.
			const onSource = sameInstance(current, action.source)
			const onBranch = !action.approval && status.status === "completed" && sameInstance(current, status)
			if (!onSource && !onBranch) return
			if (!action.approval && onSource && current!.revision > action.source.revision + 1) return
			if (action.approval && (!sameInstance(current, status) || (status.revision ?? -1) < action.source.revision))
				return
			if (status.status === "running" && !sameRevision(current, action.source)) return
			setOutcome({ status, source: action.source, approval: action.approval })
			if (status.status !== "running") {
				pendingRef.current = undefined
				setPending(undefined)
				if (action.approval && status.status !== "completed") setAnsweredApproval(undefined)
			}
		}
		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [])

	const busy = !!pending && sameInstance(state, pending.source) && state!.revision <= pending.source.revision + 1
	const open: ModelOperationControls["open"] = (kind, requestId, profileId) => {
		if (!state || busy) return
		setConfirmed(false)
		setSelection({
			source: { ...state },
			kind,
			requestId: kind === "switch" ? state.requestId : requestId,
			profileId: profileId ?? state.profileId ?? profiles.find((p) => p.name === currentApiConfigName)?.id ?? "",
		})
	}
	const stale = !!selection && !sameRevision(state, selection.source)
	const switchReason =
		selection?.kind === "switch" && (state?.readiness !== "ready" || !state.requestId)
			? state?.reason || t("chat:modelOperation.unavailable")
			: undefined
	const disabledReason = stale ? t("chat:modelOperation.stale") : switchReason
	const dispatch = () => {
		if (
			!selection ||
			!confirmed ||
			disabledReason ||
			!selection.requestId ||
			!profiles.some((p) => p.id === selection.profileId) ||
			(pendingRef.current &&
				sameInstance(state, pendingRef.current.source) &&
				state!.revision <= pendingRef.current.source.revision + 1)
		)
			return
		const { taskId, instanceId, revision } = selection.source
		const operation: ModelOperation = {
			operationId: crypto.randomUUID(),
			kind: selection.kind,
			taskId,
			instanceId,
			revision,
			profileId: selection.profileId,
			requestId: selection.requestId,
			confirmCurrentWorkspace: true,
		}
		const action = { operationId: operation.operationId, source: selection.source }
		pendingRef.current = action
		setPending(action)
		setOutcome(undefined)
		setSelection(undefined)
		vscode.postMessage({ type: "modelOperation", modelOperation: operation })
	}
	const respond = (approved: boolean) => {
		// Capture exactly the identity displayed with this approval. No normal ask-response or auto-approval path.
		if (
			!state?.approval ||
			answeredApproval === state.approval.approvalId ||
			pendingRef.current?.operationId === state.approval.approvalId
		)
			return
		const { taskId, instanceId, revision, approval } = state
		const action = { operationId: approval.approvalId, source: { taskId, instanceId, revision }, approval: true }
		pendingRef.current = action
		setPending(action)
		setOutcome(undefined)
		setAnsweredApproval(approval.approvalId)
		vscode.postMessage({
			type: "modelOperationApproval",
			modelOperationApproval: { taskId, instanceId, revision, approvalId: approval.approvalId, approved },
		})
	}
	const visibleOutcome =
		outcome &&
		(outcome.status.status === "completed" && !outcome.approval
			? sameInstance(state, outcome.status) || sameInstance(state, outcome.source)
			: sameInstance(state, outcome.source))
			? outcome.status
			: undefined

	const panel = (
		<div className="px-3 pb-2 space-y-2 max-h-48 overflow-y-auto shrink-0">
			{(visibleOutcome || busy) && (
				<div
					role={
						visibleOutcome?.status === "failed" || visibleOutcome?.status === "blocked" ? "alert" : "status"
					}
					className="text-sm break-words">
					<strong>{t(`chat:modelOperation.status.${visibleOutcome?.status ?? "running"}`)}</strong>
					{visibleOutcome && <div>{visibleOutcome.message}</div>}
				</div>
			)}
			{state?.requiresToolApproval && (
				<section aria-label={t("chat:modelOperation.approvalTitle")} className="text-sm space-y-2">
					<p className="m-0">{t("chat:modelOperation.approvalRequired")}</p>
					{state.approval && (
						<>
							<p className="m-0">
								{t("chat:modelOperation.approvalTool", { tool: state.approval.toolName })}
							</p>
							<div className="flex gap-2">
								<Button
									disabled={answeredApproval === state.approval.approvalId}
									onClick={() => respond(true)}>
									{t("chat:approve.title")}
								</Button>
								<Button
									disabled={answeredApproval === state.approval.approvalId}
									onClick={() => respond(false)}>
									{t("chat:reject.title")}
								</Button>
							</div>
						</>
					)}
				</section>
			)}
		</div>
	)
	return (
		<ModelOperationContext.Provider value={{ open, busy, panel }}>
			{children}
			<Dialog
				open={!!selection}
				onOpenChange={(value) => {
					if (!value) setSelection(undefined)
				}}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{t(
								selection?.kind === "switch"
									? "chat:modelOperation.switch"
									: "chat:modelOperation.regenerate",
							)}
						</DialogTitle>
						<DialogDescription>{t("chat:modelOperation.warning")}</DialogDescription>
					</DialogHeader>
					<label id="model-operation-profile-label">{t("chat:modelOperation.profile")}</label>
					<Select
						value={selection?.profileId || undefined}
						onValueChange={(profileId) => setSelection((value) => value && { ...value, profileId })}>
						<SelectTrigger aria-labelledby="model-operation-profile-label">
							<SelectValue placeholder={t("chat:modelOperation.profile")} />
						</SelectTrigger>
						<SelectContent>
							{profiles
								.filter((p) => p.id)
								.map((p) => (
									<SelectItem key={p.id} value={p.id!}>
										{p.name}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
					{profiles.length === 0 && <p role="alert">{t("chat:modelOperation.noProfiles")}</p>}
					{disabledReason && <p role="alert">{disabledReason}</p>}
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>
						{t("chat:modelOperation.confirmWorkspace")}
					</label>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setSelection(undefined)}>
							{t("chat:modelOperation.cancel")}
						</Button>
						<Button
							variant="primary"
							disabled={
								!confirmed ||
								!!disabledReason ||
								!selection?.requestId ||
								!profiles.some((p) => p.id === selection?.profileId) ||
								busy
							}
							onClick={dispatch}>
							{t(
								selection?.kind === "switch"
									? "chat:modelOperation.switch"
									: "chat:modelOperation.regenerate",
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</ModelOperationContext.Provider>
	)
}

export function RegenerateWithModel({ message }: { message: ClineMessage }) {
	const { t } = useTranslation()
	const { modelOperation } = useExtensionState()
	const controls = useModelOperation()
	if (message.type !== "say" || message.say !== "text" || message.partial || !message.text?.trim()) return null
	const reason = !message.requestId
		? t("chat:modelOperation.legacy")
		: !modelOperation || !controls
			? t("chat:modelOperation.unavailable")
			: undefined
	return (
		<div className="mt-2 text-sm">
			<Button
				variant="ghost"
				size="sm"
				disabled={!!reason || controls?.busy}
				onClick={() => controls?.open("regenerate", message.requestId)}>
				{t("chat:modelOperation.regenerate")}
			</Button>
			{reason && <p className="m-0 text-vscode-descriptionForeground">{reason}</p>}
		</div>
	)
}
