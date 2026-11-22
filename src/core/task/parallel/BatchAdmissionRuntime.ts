/**
 * Runtime admission for one parallel batch (ADR-2026-11-22-parallel-subtasks, rule 4).
 *
 * Shared by every child of the batch, on every provider (`providerScope: "any"`, a change to R-5).
 * - Concurrency: at most `concurrency` requests in flight. Extra requests wait for a free slot
 *   (budget-wait semantics) until a slot frees or their signal aborts.
 * - Token budget: input plus output tokens reported by settled requests. Once the total reaches
 *   or exceeds the budget, every further `admit` returns `budget-denied`.
 */

import {
	ModelDispatchControl,
	type DispatchAdmission,
	type ModelDispatchDescriptor,
	type ModelDispatchRuntime,
} from "../../../api/dispatch-admission"

export const DEFAULT_PARALLEL_CONCURRENCY = 2
export const MIN_PARALLEL_CONCURRENCY = 1
export const MAX_PARALLEL_CONCURRENCY = 4
export const DEFAULT_PARALLEL_TOKEN_BUDGET = 2_000_000

/** Clamp to 1..4; anything that is not a finite number gives the default (2). */
export function clampConcurrency(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PARALLEL_CONCURRENCY
	return Math.min(MAX_PARALLEL_CONCURRENCY, Math.max(MIN_PARALLEL_CONCURRENCY, Math.round(value)))
}

/** A positive finite number, otherwise the default (2,000,000). */
export function normalizeTokenBudget(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_PARALLEL_TOKEN_BUDGET
	return Math.floor(value)
}

export class BatchAdmissionRuntime implements ModelDispatchRuntime {
	readonly providerScope = "any" as const
	readonly concurrency: number
	readonly tokenBudget: number
	private inFlight = 0
	private used = 0
	private readonly waiters = new Set<() => void>()

	constructor(options: { concurrency?: number; tokenBudget?: number } = {}) {
		this.concurrency = clampConcurrency(options.concurrency)
		this.tokenBudget = normalizeTokenBudget(options.tokenBudget)
	}

	/** Input plus output tokens reported so far. */
	get usedTokens(): number {
		return this.used
	}

	get activeRequests(): number {
		return this.inFlight
	}

	get budgetExhausted(): boolean {
		return this.used >= this.tokenBudget
	}

	async admit(_descriptor: Readonly<ModelDispatchDescriptor>, signal: AbortSignal): Promise<DispatchAdmission> {
		if (this.budgetExhausted) return { outcome: "budget-denied" }
		while (this.inFlight >= this.concurrency) {
			await this.waitForSlot(signal)
			if (this.budgetExhausted) return { outcome: "budget-denied" }
		}
		if (signal.aborted) throw new ModelDispatchControl("cancelled")
		this.inFlight++
		let settled = false
		return {
			outcome: "granted",
			settle: () => {
				if (settled) return
				settled = true
				this.inFlight--
				this.wakeAll()
			},
		}
	}

	recordUsage(usage: { inputTokens: number; outputTokens: number }): void {
		const input = Number.isFinite(usage.inputTokens) ? Math.max(0, usage.inputTokens) : 0
		const output = Number.isFinite(usage.outputTokens) ? Math.max(0, usage.outputTokens) : 0
		this.used += input + output
		// Waiting requests re-check the budget and are denied once it is exhausted.
		if (this.budgetExhausted) this.wakeAll()
	}

	private waitForSlot(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) return reject(new ModelDispatchControl("cancelled"))
			const wake = () => {
				signal.removeEventListener("abort", onAbort)
				this.waiters.delete(wake)
				resolve()
			}
			const onAbort = () => {
				this.waiters.delete(wake)
				reject(new ModelDispatchControl("cancelled"))
			}
			this.waiters.add(wake)
			signal.addEventListener("abort", onAbort, { once: true })
		})
	}

	private wakeAll(): void {
		for (const wake of [...this.waiters]) wake()
	}
}
