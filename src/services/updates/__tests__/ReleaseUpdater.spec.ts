import * as vscode from "vscode"
import type { MockInstance } from "vitest"
import { ReleaseUpdater } from "../ReleaseUpdater"
import { findReleaseUpdate, downloadVerifiedRelease } from "../githubRelease"

vi.mock("../githubRelease", () => ({
	findReleaseUpdate: vi.fn(),
	downloadVerifiedRelease: vi.fn(),
	isStrictVersion: (v: string) => /^\d+\.\d+\.\d+$/.test(v),
	compareStrictVersions: (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }),
}))
vi.mock("../../../shared/package", () => ({
	Package: { publisher: "RooVeterinaryInc", name: "roo-cline", version: "4.2.29" },
}))

describe("release updater consent and lifecycle", () => {
	let updater: ReleaseUpdater
	let values: Map<string, unknown>
	let loaded: boolean
	let confirm: MockInstance<any>
	let execute: MockInstance<any>
	let cleanup: ReturnType<typeof vi.fn>
	const candidate = {
		version: "4.2.30",
		tag: "v4.2.30-cordis-preview.27",
		prerelease: true,
		htmlUrl: "https://github.com/ec-jt/Roo-Code/releases/tag/v4.2.30-cordis-preview.27",
	} as Awaited<ReturnType<typeof findReleaseUpdate>>
	beforeEach(() => {
		vi.resetAllMocks()
		values = new Map()
		loaded = false
		confirm = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined)
		vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
		vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined)
		execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined)
		cleanup = vi.fn().mockResolvedValue(undefined)
		vi.mocked(findReleaseUpdate).mockResolvedValue(candidate)
		vi.mocked(downloadVerifiedRelease).mockResolvedValue({
			vsixPath: "/tmp/roo-update-abcdef/roo-cline-4.2.30.vsix",
			cleanup,
		})
		updater = new ReleaseUpdater(
			{
				globalState: {
					get: (key: string) => values.get(key),
					update: async (key: string, value: unknown) => {
						values.set(key, value)
					},
				},
			} as unknown as vscode.ExtensionContext,
			() => loaded,
			vi.fn(),
		)
	})
	afterEach(() => {
		updater.dispose()
		vi.restoreAllMocks()
		vi.useRealTimers()
	})
	it("makes no automatic request by default, including scheduled ticks", async () => {
		vi.useFakeTimers()
		updater.start()
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 30_000)
		expect(findReleaseUpdate).not.toHaveBeenCalled()
		expect(updater.snapshot().automatic).toBe(false)
	})
	it("checks without downloading or asking for install consent", async () => {
		await updater.handle("check")
		expect(updater.snapshot()).toMatchObject({ phase: "available", availableVersion: "4.2.30" })
		expect(downloadVerifiedRelease).not.toHaveBeenCalled()
		expect(confirm).not.toHaveBeenCalled()
	})
	it("does not download or install if manual confirmation is dismissed", async () => {
		await updater.handle("install")
		expect(downloadVerifiedRelease).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	})
	it("installs a verified URI, cleans up, and never reloads automatically", async () => {
		confirm.mockResolvedValue("Install update")
		await updater.handle("install")
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			"workbench.extensions.installExtension",
			vscode.Uri.file("/tmp/roo-update-abcdef/roo-cline-4.2.30.vsix"),
		)
		expect(cleanup).toHaveBeenCalledOnce()
		expect(updater.snapshot()).toMatchObject({ phase: "installed", installedVersion: "4.2.30" })
		await updater.handle("install")
		expect(findReleaseUpdate).toHaveBeenCalledOnce()
	})
	it("allows manual installation while a task is loaded without reloading", async () => {
		loaded = true
		confirm.mockResolvedValue("Install update")
		await updater.handle("install")
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			"workbench.extensions.installExtension",
			vscode.Uri.file("/tmp/roo-update-abcdef/roo-cline-4.2.30.vsix"),
		)
		expect(updater.snapshot().phase).toBe("installed")
	})
	it("installs even if a task loads during download, then cleans up", async () => {
		confirm.mockResolvedValue("Install update")
		vi.mocked(downloadVerifiedRelease).mockImplementation(async () => {
			loaded = true
			return { vsixPath: "/tmp/unused.vsix", cleanup }
		})
		await updater.handle("install")
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			"workbench.extensions.installExtension",
			vscode.Uri.file("/tmp/unused.vsix"),
		)
		expect(cleanup).toHaveBeenCalledOnce()
	})
	it("allows opted-in automatic installation with a loaded task without reloading", async () => {
		loaded = true
		confirm.mockResolvedValue("Enable automatic updates")
		await updater.handle("enableAutomatic")
		await updater.runAutomatic()
		expect(updater.snapshot().phase).toBe("installed")
		expect(execute).toHaveBeenCalledExactlyOnceWith(
			"workbench.extensions.installExtension",
			vscode.Uri.file("/tmp/roo-update-abcdef/roo-cline-4.2.30.vsix"),
		)
	})
	it("still blocks reload while a task is loaded", async () => {
		loaded = true
		confirm.mockResolvedValue("Install update")
		await updater.handle("install")
		execute.mockClear()
		confirm.mockResolvedValue("Reload Window")
		await updater.handle("reload")
		expect(execute).not.toHaveBeenCalled()
		expect(confirm).toHaveBeenLastCalledWith(
			"Close the loaded Roo task before reloading. Reloading interrupts the extension host.",
		)
	})
	it("requires explicit native opt-in for automatic installation", async () => {
		await updater.handle("enableAutomatic")
		expect(values.get("githubReleaseUpdater.automatic")).not.toBe(true)
		confirm.mockResolvedValue("Enable automatic updates")
		await updater.handle("enableAutomatic")
		expect(updater.snapshot().automatic).toBe(true)
		confirm.mockClear()
		await updater.runAutomatic()
		expect(confirm).not.toHaveBeenCalled()
		expect(execute).toHaveBeenCalledOnce()
	})
	it("disabling automation during download prevents install", async () => {
		confirm.mockResolvedValue("Enable automatic updates")
		await updater.handle("enableAutomatic")
		vi.mocked(downloadVerifiedRelease).mockImplementation(async () => {
			await updater.handle("disableAutomatic")
			return { vsixPath: "/tmp/unused.vsix", cleanup }
		})
		await updater.runAutomatic()
		expect(execute).not.toHaveBeenCalled()
		expect(cleanup).toHaveBeenCalledOnce()
		expect(updater.snapshot().automatic).toBe(false)
	})
	it("never installs after failed verification", async () => {
		confirm.mockResolvedValue("Install update")
		vi.mocked(downloadVerifiedRelease).mockRejectedValue(new Error("Checksum mismatch"))
		await updater.handle("install")
		expect(execute).not.toHaveBeenCalled()
		expect(updater.snapshot()).toMatchObject({ phase: "error", message: "Checksum mismatch" })
	})
	it("cleans up and reports an installation failure", async () => {
		confirm.mockResolvedValue("Install update")
		execute.mockRejectedValue(new Error("Installer unavailable"))
		await updater.handle("install")
		expect(cleanup).toHaveBeenCalledOnce()
		expect(updater.snapshot().phase).toBe("error")
		expect(values.get("githubReleaseUpdater.installedVersion")).toBeUndefined()
	})
	it("single-flights concurrent updates", async () => {
		let resolve!: (value: typeof candidate) => void
		vi.mocked(findReleaseUpdate).mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done
				}),
		)
		const pending = updater.handle("check")
		await updater.handle("install")
		expect(findReleaseUpdate).toHaveBeenCalledOnce()
		resolve(candidate)
		await pending
	})
	it("only reloads after explicit confirmation with no loaded task", async () => {
		confirm.mockResolvedValue("Install update")
		await updater.handle("install")
		execute.mockClear()
		await updater.handle("reload")
		expect(execute).not.toHaveBeenCalled()
		confirm.mockResolvedValue("Reload Window")
		await updater.handle("reload")
		expect(execute).toHaveBeenCalledExactlyOnceWith("workbench.action.reloadWindow")
	})
})
