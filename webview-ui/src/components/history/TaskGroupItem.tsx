import { memo } from "react"
import { cn } from "@/lib/utils"
import type { TaskGroup } from "./types"
import { countAllSubtasks } from "./types"
import TaskItem from "./TaskItem"
import SubtaskCollapsibleRow from "./SubtaskCollapsibleRow"
import SubtaskRow from "./SubtaskRow"

interface TaskGroupItemProps {
	background?: boolean
	/** The task group to render */
	group: TaskGroup
	/** Display variant - compact (preview) or full (history view) */
	variant: "compact" | "full"
	/** Whether to show workspace info */
	showWorkspace?: boolean
	/** Whether selection mode is active */
	isSelectionMode?: boolean
	/** Whether this group's parent is selected */
	isSelected?: boolean
	/** Callback when selection state changes */
	onToggleSelection?: (taskId: string, isSelected: boolean) => void
	/** Callback when delete is requested */
	onDelete?: (taskId: string) => void
	/** Callback when the parent group expand/collapse is toggled */
	onToggleExpand: () => void
	/** Callback when a nested subtask node expand/collapse is toggled */
	onToggleSubtaskExpand: (taskId: string) => void
	/** Optional className for styling */
	className?: string
}

/**
 * Renders a task group consisting of a parent task and its collapsible subtask tree.
 * When expanded, shows recursively nested subtask rows.
 */
const TaskGroupItem = ({
	group,
	variant,
	showWorkspace = false,
	isSelectionMode = false,
	isSelected = false,
	onToggleSelection,
	onDelete,
	onToggleExpand,
	onToggleSubtaskExpand,
	className,
	background = false,
}: TaskGroupItemProps) => {
	const { parent, subtasks, isExpanded } = group
	const hasSubtasks = subtasks.length > 0
	const totalSubtaskCount = hasSubtasks ? countAllSubtasks(subtasks) : 0

	return (
		<div
			data-testid={`task-group-${parent.id}`}
			className={cn(
				"bg-vscode-editor-background rounded-xl border border-transparent overflow-hidden",
				className,
			)}>
			{/* Parent task */}
			<TaskItem
				item={parent}
				background={background}
				variant={variant}
				showWorkspace={showWorkspace}
				isSelectionMode={isSelectionMode}
				isSelected={isSelected}
				onToggleSelection={onToggleSelection}
				onDelete={onDelete}
				hasSubtasks={hasSubtasks}
			/>

			{/* Subtask collapsible row — shows total recursive count */}
			{hasSubtasks && (
				<SubtaskCollapsibleRow count={totalSubtaskCount} isExpanded={isExpanded} onToggle={onToggleExpand} />
			)}

			{/* Expanded subtask tree */}
			{hasSubtasks && (
				<div
					data-testid="subtask-list"
					className={cn(
						"transition-all duration-500",
						// Expanded subtask trees can be very tall; cap the height but make the
						// region independently scrollable so long lists remain reachable.
						isExpanded ? "max-h-[70vh] overflow-y-auto pb-2" : "max-h-0 overflow-clip",
					)}>
					{subtasks.map((node) => (
						<SubtaskRow
							key={node.item.id}
							node={node}
							depth={1}
							onToggleExpand={onToggleSubtaskExpand}
							background={background}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export default memo(TaskGroupItem)
