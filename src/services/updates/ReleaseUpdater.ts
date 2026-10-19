import * as vscode from "vscode"
import type { ReleaseUpdateState } from "@roo-code/types"
import { Package } from "../../shared/package"
import {
	compareStrictVersions,
	downloadVerifiedRelease,
	findReleaseUpdate,
	isStrictVersion,
	type ReleaseCandidate,
} from "./githubRelease"

// Deliberately not in importable/synced Roo settings: enabling code installation
// requires native confirmation on this extension host, not a settings import.
const AUTO_KEY = "githubReleaseUpdater.automatic"
const INSTALLED_KEY = "githubReleaseUpdater.installedVersion"
const INTERVAL_MS = 6 * 60 * 60_000

export type ReleaseUpdateAction =
	| "status"
	| "check"
	| "install"
	| "enableAutomatic"
	| "disableAutomatic"
	| "cancel"
	| "reload"

export class ReleaseUpdater implements vscode.Disposable {
	private state: ReleaseUpdateState
	private candidate?: ReleaseCandidate
	private controller?: AbortController
	private busy = false
	private disposed = false
	private consentPending = false
	private automaticRevision = 0
	private timer?: ReturnType<typeof setTimeout>
	private interval?: ReturnType<typeof setInterval>

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly hasLoadedTask: () => boolean,
		private readonly publish: (state: ReleaseUpdateState) => void,
	) {
		const recorded = context.globalState.get<string>(INSTALLED_KEY)
		const installedVersion =
			recorded && isStrictVersion(recorded) && compareStrictVersions(recorded, Package.version) > 0
				? recorded
				: undefined
		this.state = {
			phase: installedVersion ? "installed" : "idle",
			currentVersion: Package.version,
			automatic: context.globalState.get(AUTO_KEY) === true,
			host: vscode.env.remoteName ? `Remote extension host (${vscode.env.remoteName})` : "Current extension host",
			installedVersion,
			message: installedVersion
				? `Version ${installedVersion} was installed. Reload the window to activate it.`
				: "Manual updates only unless automatic updates are explicitly enabled.",
		}
	}

	start(): void {
		this.timer = setTimeout(() => {
			void this.runAutomatic()
		}, 30_000)
		this.interval = setInterval(() => {
			void this.runAutomatic()
		}, INTERVAL_MS)
		this.timer.unref?.()
		this.interval.unref?.()
	}

	snapshot(): ReleaseUpdateState {
		return { ...this.state }
	}
	private setState(update: Partial<ReleaseUpdateState>): void {
		this.state = { ...this.state, ...update }
		if (!this.disposed) this.publish(this.snapshot())
	}
	private enabled(): boolean {
		return this.context.globalState.get(AUTO_KEY) === true
	}
	private currentVersion(): string {
		return this.state.installedVersion ?? Package.version
	}
	private assertReady(signal: AbortSignal, automatic: boolean, revision: number): void {
		if (this.disposed || signal.aborted) throw new Error("Update cancelled before installation.")
		if (automatic && (!this.enabled() || revision !== this.automaticRevision))
			throw new Error("Automatic update consent changed. Installation stopped.")
	}

	async handle(action: ReleaseUpdateAction): Promise<void> {
		if (this.disposed) return
		if (action === "status") {
			this.publish(this.snapshot())
			return
		}
		if (action === "cancel") {
			if (this.state.phase !== "installing") this.controller?.abort()
			return
		}
		if (action === "enableAutomatic" || action === "disableAutomatic") {
			await this.setAutomatic(action === "enableAutomatic")
			return
		}
		if (action === "reload") {
			if (!this.state.installedVersion || this.busy) return
			if (this.hasLoadedTask()) {
				void vscode.window.showWarningMessage(
					"Close the loaded Roo task before reloading. Reloading interrupts the extension host.",
				)
				return
			}
			const answer = await vscode.window.showWarningMessage(
				"Reload this VS Code window to activate the installed Roo update?",
				{ modal: true },
				"Reload Window",
			)
			if (answer === "Reload Window" && !this.disposed && !this.hasLoadedTask())
				await vscode.commands.executeCommand("workbench.action.reloadWindow")
			return
		}
		if (action === "check" || action === "install") await this.run(action === "install", false)
	}

	private async setAutomatic(enabled: boolean): Promise<void> {
		if (!enabled) {
			this.automaticRevision++
			await this.context.globalState.update(AUTO_KEY, false)
			if (this.state.phase !== "installing") this.controller?.abort()
			this.setState({
				automatic: false,
				message:
					this.state.phase === "installing"
						? "Automatic updates disabled. The installation already handed to VS Code cannot be cancelled here."
						: "Automatic updates disabled. Use Check for updates or Update / install latest manually.",
			})
			return
		}
		if (this.consentPending || this.enabled()) return
		this.consentPending = true
		const revision = this.automaticRevision
		try {
			const answer = await vscode.window.showWarningMessage(
				"Enable automatic installation of ec-jt/Roo-Code GitHub releases on this extension host?",
				{
					modal: true,
					detail: "Includes experimental Cordis prereleases. Checks at startup and every six hours, and can install while a Roo task is loaded. Downloads and checksums come from this repository, not the Marketplace. Reload remains manual and interrupts the extension host. Enable only if you trust this release publisher.",
				},
				"Enable automatic updates",
			)
			if (answer !== "Enable automatic updates" || this.disposed || revision !== this.automaticRevision) return
			await this.context.globalState.update(AUTO_KEY, true)
			if (this.disposed || revision !== this.automaticRevision) {
				await this.context.globalState.update(AUTO_KEY, false)
				return
			}
			this.setState({
				automatic: true,
				message:
					"Automatic GitHub updates enabled on this host. Updates can install while a task is loaded. Reload remains manual.",
			})
		} finally {
			this.consentPending = false
			this.publish(this.snapshot())
		}
	}

	async runAutomatic(): Promise<void> {
		if (this.disposed || !this.enabled() || this.busy || this.state.installedVersion) return
		await this.run(true, true)
	}

	private async run(install: boolean, automatic: boolean): Promise<void> {
		if (this.busy || this.disposed) return
		if (this.state.installedVersion) {
			this.setState({
				phase: "installed",
				message: `Version ${this.state.installedVersion} is already staged. Reload before another update.`,
			})
			return
		}
		this.busy = true
		const controller = new AbortController()
		this.controller = controller
		const revision = this.automaticRevision
		let cleanup: (() => Promise<void>) | undefined
		try {
			if (`${Package.publisher}.${Package.name}`.toLowerCase() !== "rooveterinaryinc.roo-cline")
				throw new Error("This updater only installs the standard Roo fork, not nightly or renamed variants.")
			if (install) this.assertReady(controller.signal, automatic, revision)
			this.setState({
				phase: "checking",
				message: "Checking ec-jt/Roo-Code releases, including Cordis previews…",
				availableVersion: undefined,
				releaseUrl: undefined,
			})
			this.candidate = await findReleaseUpdate(this.currentVersion(), controller.signal)
			if (this.disposed || controller.signal.aborted) throw new Error("Update check cancelled.")
			const candidate = this.candidate
			if (!candidate) {
				this.setState({
					phase: "idle",
					message:
						"No newer release with matching VSIX and checksum assets was found in the latest 300 releases.",
				})
				return
			}
			this.setState({
				phase: "available",
				availableVersion: candidate.version,
				releaseUrl: candidate.htmlUrl,
				message: `Version ${candidate.version} is available${candidate.prerelease ? " (prerelease)" : ""}.`,
			})
			if (!install) return
			if (!automatic) {
				const answer = await vscode.window.showWarningMessage(
					`Install Roo ${candidate.version}${candidate.prerelease ? " (experimental prerelease)" : ""} on this extension host?`,
					{
						modal: true,
						detail: `Source: ${candidate.htmlUrl}\nThe VSIX will be downloaded and verified before VS Code installs it. Settings and task storage are not removed. Reload is manual.`,
					},
					"Install update",
				)
				if (answer !== "Install update") return
			}
			this.assertReady(controller.signal, automatic, revision)
			this.setState({ phase: "downloading", message: `Downloading and verifying Roo ${candidate.version}…` })
			const downloaded = await downloadVerifiedRelease(candidate, controller.signal)
			cleanup = downloaded.cleanup
			this.assertReady(controller.signal, automatic, revision)
			this.setState({
				phase: "installing",
				message: "Verification passed. Waiting for VS Code to install the VSIX…",
			})
			// Pass a URI, never a string (strings select Marketplace IDs). Remote EH
			// RPC transforms file URIs into remote URIs for the workbench installer.
			await vscode.commands.executeCommand(
				"workbench.extensions.installExtension",
				vscode.Uri.file(downloaded.vsixPath),
			)
			this.setState({
				phase: "installed",
				installedVersion: candidate.version,
				message: `VS Code completed installation of Roo ${candidate.version}. Reload this window when ready to activate it.`,
			})
			try {
				await this.context.globalState.update(INSTALLED_KEY, candidate.version)
			} catch {
				/* Installation succeeded; a receipt failure must not report an install failure. */
			}
			void vscode.window.showInformationMessage(
				`Roo ${candidate.version} installed. Use Developer: Reload Window when ready. Other extension hosts need their own update.`,
			)
		} catch (error) {
			const message = controller.signal.aborted
				? "Update cancelled before installation."
				: error instanceof Error
					? error.message
					: "Release update failed."
			this.setState({ phase: "error", message })
			if (!automatic && !this.disposed && !controller.signal.aborted)
				void vscode.window.showErrorMessage(`Roo update: ${message}`)
		} finally {
			try {
				await cleanup?.()
			} finally {
				this.controller = undefined
				this.busy = false
			}
		}
	}

	dispose(): void {
		this.disposed = true
		clearTimeout(this.timer)
		clearInterval(this.interval)
		this.controller?.abort()
	}
}

let updater: ReleaseUpdater | undefined
export function initializeReleaseUpdater(
	context: vscode.ExtensionContext,
	hasLoadedTask: () => boolean,
	publish: (state: ReleaseUpdateState) => void,
): ReleaseUpdater {
	updater?.dispose()
	updater = new ReleaseUpdater(context, hasLoadedTask, publish)
	context.subscriptions.push(updater)
	updater.start()
	return updater
}
export function getReleaseUpdater(): ReleaseUpdater | undefined {
	return updater
}
