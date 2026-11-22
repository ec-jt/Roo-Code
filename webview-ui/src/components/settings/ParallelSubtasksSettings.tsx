import { useEffect, useState } from "react"

import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Input, Slider } from "@src/components/ui"

import type { SetCachedStateField } from "./types"
import { SearchableSetting } from "./SearchableSetting"

/** Same defaults and limits as the extension (src/core/task/parallel/BatchAdmissionRuntime.ts). */
export const PARALLEL_CONCURRENCY_DEFAULT = 2
export const PARALLEL_CONCURRENCY_MIN = 1
export const PARALLEL_CONCURRENCY_MAX = 4
export const PARALLEL_TOKEN_BUDGET_DEFAULT = 2_000_000
export const PARALLEL_TOKEN_BUDGET_MIN = 100_000

type Props = {
	concurrency?: number
	tokenBudget?: number
	setCachedStateField: SetCachedStateField<"parallelSubtasksConcurrency" | "parallelSubtasksTokenBudget">
}

/** Batch limits for parallel subtasks (ADR-2026-11-22-parallel-subtasks rule 4). Shown when the experiment is on. */
export const ParallelSubtasksSettings = ({ concurrency, tokenBudget, setCachedStateField }: Props) => {
	const { t } = useAppTranslation()
	const effectiveConcurrency = concurrency ?? PARALLEL_CONCURRENCY_DEFAULT
	const effectiveBudget = tokenBudget ?? PARALLEL_TOKEN_BUDGET_DEFAULT
	const [budgetText, setBudgetText] = useState(String(effectiveBudget))
	useEffect(() => setBudgetText(String(effectiveBudget)), [effectiveBudget])
	const parsedBudget = Number(budgetText)
	const budgetValid = Number.isInteger(parsedBudget) && parsedBudget >= PARALLEL_TOKEN_BUDGET_MIN

	return (
		<div className="flex flex-col gap-3 pl-6">
			<SearchableSetting
				settingId="experimental-parallel-subtasks-concurrency"
				section="experimental"
				label={t("settings:experimental.parallelSubtasks.concurrencyLabel")}>
				<span className="block font-medium mb-1">
					{t("settings:experimental.parallelSubtasks.concurrencyLabel")}
				</span>
				<div className="flex items-center gap-2">
					<Slider
						min={PARALLEL_CONCURRENCY_MIN}
						max={PARALLEL_CONCURRENCY_MAX}
						step={1}
						value={[effectiveConcurrency]}
						onValueChange={([value]) => setCachedStateField("parallelSubtasksConcurrency", value)}
						data-testid="parallel-subtasks-concurrency-slider"
					/>
					<span className="w-10" data-testid="parallel-subtasks-concurrency-value">
						{effectiveConcurrency}
					</span>
				</div>
				<div className="text-vscode-descriptionForeground text-sm mt-1">
					{t("settings:experimental.parallelSubtasks.concurrencyDescription")}
				</div>
			</SearchableSetting>
			<SearchableSetting
				settingId="experimental-parallel-subtasks-token-budget"
				section="experimental"
				label={t("settings:experimental.parallelSubtasks.tokenBudgetLabel")}>
				<span className="block font-medium mb-1">
					{t("settings:experimental.parallelSubtasks.tokenBudgetLabel")}
				</span>
				<Input
					type="number"
					min={PARALLEL_TOKEN_BUDGET_MIN}
					step={100_000}
					value={budgetText}
					onChange={(event) => {
						const text = event.target.value
						setBudgetText(text)
						const value = Number(text)
						if (Number.isInteger(value) && value >= PARALLEL_TOKEN_BUDGET_MIN) {
							setCachedStateField("parallelSubtasksTokenBudget", value)
						}
					}}
					aria-invalid={!budgetValid}
					data-testid="parallel-subtasks-token-budget-input"
				/>
				{!budgetValid && (
					<div className="text-vscode-errorForeground text-sm mt-1">
						{t("settings:experimental.parallelSubtasks.tokenBudgetMinimum", {
							min: PARALLEL_TOKEN_BUDGET_MIN.toLocaleString(),
						})}
					</div>
				)}
				<div className="text-vscode-descriptionForeground text-sm mt-1">
					{t("settings:experimental.parallelSubtasks.tokenBudgetDescription")}
				</div>
			</SearchableSetting>
		</div>
	)
}
