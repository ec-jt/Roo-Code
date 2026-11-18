import { DesktopSession } from "./DesktopSession"
import { LibnutDriver } from "./LibnutDriver"
import { loadLibnut } from "./libnutLoader"
import { createIdleProbe, UserActivityMonitor } from "./userActivity"
import { createMacBackgroundControl, createMacFastScreenCapture } from "./macBackground"
import * as vscode from "vscode"

/**
 * One DesktopSession per task. The session holds screenshot geometry, so it must
 * live as long as the task's conversation with the model.
 *
 * Keyed by an opaque owner object (the Task) so this module has no dependency on Task.
 */

export type DesktopSessionFactory = (extensionPath: string) => DesktopSession

const defaultFactory: DesktopSessionFactory = (extensionPath) => {
	const driver = new LibnutDriver(loadLibnut(extensionPath))
	const activity = new UserActivityMonitor({
		getCursor: () => driver.getMousePosition(),
		idleProbe: createIdleProbe(),
	})
	const isMac = process.platform === "darwin"
	const background = isMac ? createMacBackgroundControl() : undefined
	const fastCapture = isMac ? createMacFastScreenCapture() : undefined
	const clipboard = {
		read: async () => vscode.env.clipboard.readText(),
		write: async (text: string) => vscode.env.clipboard.writeText(text),
	}
	return new DesktopSession(driver, { activity, background, fastCapture, clipboard })
}

let factory: DesktopSessionFactory = defaultFactory

const sessions = new WeakMap<object, DesktopSession>()

export function getDesktopSession(owner: object, extensionPath: string): DesktopSession {
	let session = sessions.get(owner)
	if (!session) {
		session = factory(extensionPath)
		sessions.set(owner, session)
	}
	return session
}

export function hasDesktopSession(owner: object): boolean {
	return sessions.has(owner)
}

/** Drop the session for an owner (task abort or dispose). No native cleanup is needed. */
export function releaseDesktopSession(owner: object): void {
	sessions.delete(owner)
}

/** Test hook. Pass undefined to restore the default. */
export function setDesktopSessionFactory(next: DesktopSessionFactory | undefined): void {
	factory = next ?? defaultFactory
}
