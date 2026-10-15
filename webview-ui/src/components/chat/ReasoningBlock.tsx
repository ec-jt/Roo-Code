import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import { Lightbulb, ChevronUp, LoaderCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface ReasoningBlockProps {
	content: string
	ts: number
	isStreaming: boolean
	isLast: boolean
	metadata?: any
	truncated?: boolean
	onOpenFull?: () => void
}

export const ReasoningBlock = ({ content, ts, isStreaming, isLast, truncated, onOpenFull }: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const { reasoningBlockCollapsed } = useExtensionState()

	const [isCollapsed, setIsCollapsed] = useState(reasoningBlockCollapsed ?? true)

	// Anchor the timer to the message timestamp rather than component mount so
	// the duration survives re-mounts (e.g. scrolling with virtualized lists).
	const startTimeRef = useRef<number>(ts || Date.now())
	const [elapsed, setElapsed] = useState<number>(0)
	const contentRef = useRef<HTMLPreElement>(null)
	// Plain text tolerates a suffix that starts inside Markdown or a code fence.
	const tail = content.slice(-4096).replace(/^[\uDC00-\uDFFF]/, "")
	const [following, setFollowing] = useState(true)

	useEffect(() => {
		setIsCollapsed(reasoningBlockCollapsed ?? true)
		setFollowing(true)
		startTimeRef.current = ts || Date.now()
	}, [reasoningBlockCollapsed, ts])

	useEffect(() => {
		if (!isCollapsed && following && contentRef.current)
			contentRef.current.scrollTop = contentRef.current.scrollHeight
	}, [tail, isCollapsed, following])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => setElapsed(Date.now() - startTimeRef.current)
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

	const seconds = Math.floor(elapsed / 1000)
	const secondsLabel = t("chat:reasoning.seconds", { count: seconds })

	const handleToggle = () => {
		setIsCollapsed(!isCollapsed)
		setFollowing(true)
	}

	const hasContent = (content?.trim()?.length ?? 0) > 0
	const isActive = isLast && isStreaming

	// Once streaming is over, an empty reasoning block carries no information —
	// don't render a perpetual "Thinking" header with nothing in it.
	if (!hasContent && !isActive) {
		return null
	}

	return (
		<div className="group py-1" data-testid="reasoning-block">
			<button
				type="button"
				aria-expanded={!isCollapsed}
				className="flex w-full items-center justify-between gap-2 py-1 pr-2 text-xs cursor-pointer select-none"
				onClick={handleToggle}>
				<span className="flex items-center gap-2">
					{isActive ? (
						<LoaderCircle aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
					) : (
						<Lightbulb aria-hidden="true" className="size-3" />
					)}
					<span className="font-medium text-vscode-foreground" role={isActive ? "status" : undefined}>
						{isActive ? "Reasoning…" : "Reasoning"}
					</span>
					{elapsed > 0 && <span className="text-xs text-vscode-descriptionForeground">{secondsLabel}</span>}
				</span>
				<span className="flex items-center gap-2">
					<ChevronUp className={cn("w-3 transition-transform", isCollapsed && "-rotate-180")} />
				</span>
			</button>
			{hasContent && !isCollapsed && (
				<>
					<div className="flex items-center justify-between gap-2 text-xs text-vscode-descriptionForeground mb-1">
						<span>
							{truncated || content.length > tail.length ? "Latest reasoning tail" : "Reasoning preview"}
						</span>
						<div className="flex gap-2">
							{isActive && !following && (
								<button type="button" className="underline" onClick={() => setFollowing(true)}>
									Follow latest
								</button>
							)}
							{onOpenFull && (
								<button type="button" className="underline" onClick={onOpenFull}>
									Open full reasoning
								</button>
							)}
						</div>
					</div>
					<pre
						ref={contentRef}
						data-testid="reasoning-tail"
						onScroll={() => {
							const node = contentRef.current
							if (node) setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 24)
						}}
						className="max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-4 border-l border-vscode-descriptionForeground/20 ml-1 pl-2 my-0 text-vscode-descriptionForeground">
						{tail}
					</pre>
				</>
			)}
		</div>
	)
}
