import type { HistoryItem, ModeConfig, TodoItem } from "@roo-code/types"

import { getModeBySlug } from "../../shared/modes"
import type { Task } from "./Task"
import type { ClineProvider } from "../webview/ClineProvider"

const FINISH_IN_CHILD = "Continue directly in this task, or report the limitation to the parent."

export class DelegationPolicyError extends Error {
	constructor(message: string) {
		super(`${message} ${FINISH_IN_CHILD}`)
		this.name = "DelegationPolicyError"
	}
}

/** Walk persisted parent links, never the active stack (which normally contains just one task). */
export async function resolveDelegationAncestry(
	task: Pick<Task, "taskId" | "parentTaskId" | "rootTaskId">,
	read: (id: string) => Promise<Pick<HistoryItem, "id" | "parentTaskId" | "rootTaskId">>,
): Promise<string[]> {
	const chain: string[] = []
	const roots: string[] = []
	let id: string | undefined = task.taskId
	while (id) {
		if (chain.includes(id)) throw new DelegationPolicyError("Delegation blocked: cyclic task ancestry.")
		let item: Awaited<ReturnType<typeof read>>
		try {
			item = await read(id)
		} catch {
			throw new DelegationPolicyError("Delegation blocked: missing durable task ancestry.")
		}
		if (!item || item.id !== id) throw new DelegationPolicyError("Delegation blocked: invalid task ancestry.")
		if (!chain.length && task.parentTaskId && task.parentTaskId !== item.parentTaskId) {
			throw new DelegationPolicyError("Delegation blocked: inconsistent parent ancestry.")
		}
		chain.push(id)
		if (item.rootTaskId) roots.push(item.rootTaskId)
		id = item.parentTaskId
	}
	if (task.rootTaskId) roots.push(task.rootTaskId)
	if (roots.some((root) => root !== chain[chain.length - 1])) {
		throw new DelegationPolicyError("Delegation blocked: incomplete or inconsistent root ancestry.")
	}
	return chain
}

/** Regex containment is not generally decidable here: require identical restrictions or remove the group. */
export function isEqualOrNarrowerMode(source: ModeConfig, destination: ModeConfig): boolean {
	return destination.groups.every((entry) => {
		const [name, options] = typeof entry === "string" ? [entry, undefined] : entry
		const original = source.groups.find((group) => (typeof group === "string" ? group : group[0]) === name)
		if (!original) return false
		const restriction = typeof original === "string" ? undefined : original[1].fileRegex
		return !restriction || restriction === options?.fileRegex
	})
}

export interface DelegationRequest {
	parentTaskId: string
	/** Tool callers bind the originating instance, not merely its durable ID. */
	parentInstanceId?: string
	expectedRevision?: number
	message: string
	initialTodos: TodoItem[]
	mode: string
	reason?: string
}

/** A local, one-call approval. No persisted grant, auto-approval path, or blanket override exists. */
export async function authorizeDelegation(
	provider: ClineProvider,
	parent: Task,
	request: DelegationRequest,
	confirm: (detail: string) => Promise<boolean>,
): Promise<{ revalidate: () => Promise<void>; assertCurrent: () => void }> {
	const revision = provider.delegationRevision
	const instanceId = parent.instanceId
	const api = parent.api
	const requestKey = JSON.stringify(request)
	const assertCurrent = () => {
		if (
			provider.getCurrentTask() !== parent ||
			parent.instanceId !== instanceId ||
			parent.taskId !== request.parentTaskId ||
			(request.parentInstanceId !== undefined && parent.instanceId !== request.parentInstanceId) ||
			parent.abort ||
			parent.abandoned ||
			provider.delegationRevision !== revision ||
			(request.expectedRevision !== undefined && request.expectedRevision !== revision) ||
			parent.api !== api ||
			JSON.stringify(request) !== requestKey
		) {
			throw new DelegationPolicyError(
				"Delegation cancelled: task, mode, profile, or request changed. Request again if necessary.",
			)
		}
	}
	const snapshot = async () => {
		assertCurrent()
		await parent.assertCanDelegate()
		const state = await provider.getState()
		const ancestry = await resolveDelegationAncestry(
			parent,
			async (id) => (await provider.getTaskWithId(id)).historyItem,
		)
		assertCurrent()
		const source = getModeBySlug(state.mode, state.customModes)
		const destination = getModeBySlug(request.mode, state.customModes)
		if (!source || !destination)
			throw new DelegationPolicyError("Delegation blocked: mode configuration is unavailable.")
		if (ancestry.length > 1 && !isEqualOrNarrowerMode(source, destination)) {
			throw new DelegationPolicyError(
				"Delegation blocked: a child cannot delegate to wider or unproven tool/file capabilities.",
			)
		}
		return {
			depth: ancestry.length - 1,
			key: JSON.stringify({
				ancestry,
				source,
				destination,
				customModes: state.customModes,
				profile: state.currentApiConfigName,
				configuration: state.apiConfiguration,
				organization: state.organizationAllowList,
			}),
		}
	}
	const initial = await snapshot()
	if (initial.depth >= 1) {
		if (typeof request.reason !== "string" || !request.reason.trim()) {
			throw new DelegationPolicyError(
				"Delegation blocked: children execute directly (default maximum depth is 1). Exceptional deeper delegation requires a concrete 'reason' and separate human approval for this action.",
			)
		}
		const approved = await confirm(
			`Task: ${parent.taskId} (${instanceId})\nDepth: ${initial.depth} -> ${initial.depth + 1}\nDestination mode: ${request.mode}\n\nJustification:\n${request.reason}\n\nTask content:\n${request.message}\n\nInitial todos:\n${JSON.stringify(request.initialTodos)}\n\nThis approves only this delegation. It does not approve further nesting or wider permissions.`,
		)
		assertCurrent()
		if (!approved) {
			provider.log(
				`[delegation] Denied depth ${initial.depth + 1} from ${parent.taskId}.${instanceId} to ${request.mode}`,
			)
			throw new DelegationPolicyError("Deeper delegation denied by the user.")
		}
		provider.log(
			`[delegation] Human approved one action at depth ${initial.depth + 1} from ${parent.taskId}.${instanceId} to ${request.mode}`,
		)
	}
	// Revalidate after approval and again after flushing, immediately before disposal.
	const revalidate = async () => {
		if ((await snapshot()).key !== initial.key) {
			throw new DelegationPolicyError(
				"Delegation cancelled: ancestry, mode, or profile changed while awaiting approval.",
			)
		}
		assertCurrent()
	}
	await revalidate()
	return { revalidate, assertCurrent }
}

export function delegationContext(depth: number | undefined): string {
	if (depth === undefined)
		return "Task ancestry could not be verified. Execute directly; delegation is blocked until durable ancestry is available."
	if (depth === 0)
		return "You are the root task (depth 0). You may delegate substantial, separable work to a child (depth 1). Execute small or straightforward work directly."
	return `You are a child task (depth ${depth}). Execute the assigned work directly and report to your parent. Do not create further subtasks by default. Only an exceptional need with a concrete reason and explicit per-action human approval can permit another level. Never delegate to evade tool/file restrictions. If blocked or denied, finish here or report the limitation to your parent.`
}
