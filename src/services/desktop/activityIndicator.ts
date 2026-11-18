import * as vscode from "vscode"

import { getCommand } from "../../utils/commands"

/**
 * Status bar indicator shown while Roo controls the desktop.
 *
 * Visible while any computer_action is executing, and for LINGER_MS after the
 * last one finishes, so the user can see that desktop control is in progress
 * between steps. Clicking it runs the stop command.
 */

export const LINGER_MS = 10_000

export interface ActivityIndicatorOptions {
	lingerMs?: number
	createItem?: () => vscode.StatusBarItem
}

export class DesktopActivityIndicator implements vscode.Disposable {
	private item: vscode.StatusBarItem | undefined
	private active = 0
	private hideTimer: ReturnType<typeof setTimeout> | undefined
	private readonly lingerMs: number
	private readonly createItem: () => vscode.StatusBarItem

	constructor(options: ActivityIndicatorOptions = {}) {
		this.lingerMs = options.lingerMs ?? LINGER_MS
		this.createItem =
			options.createItem ?? (() => vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000))
	}

	/** Call when an action starts. Returns a function to call when it ends. */
	begin(label?: string): () => void {
		this.active++
		this.clearHideTimer()
		this.show(label)

		let ended = false
		return () => {
			if (ended) return
			ended = true
			this.active = Math.max(0, this.active - 1)
			if (this.active === 0) {
				this.scheduleHide()
			}
		}
	}

	/** Hide immediately (used by the stop command). */
	reset(): void {
		this.active = 0
		this.clearHideTimer()
		this.item?.hide()
	}

	isVisible(): boolean {
		return this.active > 0 || this.hideTimer !== undefined
	}

	dispose(): void {
		this.clearHideTimer()
		this.item?.dispose()
		this.item = undefined
	}

	private show(label?: string): void {
		if (!this.item) {
			this.item = this.createItem()
			this.item.command = getCommand("stopComputerUse")
			this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground")
		}
		this.item.text = "$(device-desktop) Roo is controlling the desktop"
		this.item.tooltip = `${label ? `Last action: ${label}\n` : ""}Click to stop desktop control and cancel the task.`
		this.item.show()
	}

	private scheduleHide(): void {
		this.clearHideTimer()
		this.hideTimer = setTimeout(() => {
			this.hideTimer = undefined
			if (this.active === 0) {
				this.item?.hide()
			}
		}, this.lingerMs)
	}

	private clearHideTimer(): void {
		if (this.hideTimer) {
			clearTimeout(this.hideTimer)
			this.hideTimer = undefined
		}
	}
}

let instance: DesktopActivityIndicator | undefined

export function getDesktopActivityIndicator(): DesktopActivityIndicator {
	instance ??= new DesktopActivityIndicator()
	return instance
}

/** Test hook. */
export function setDesktopActivityIndicator(next: DesktopActivityIndicator | undefined): void {
	instance?.dispose()
	instance = next
}
