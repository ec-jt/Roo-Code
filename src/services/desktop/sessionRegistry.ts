import { DesktopSession } from "./DesktopSession"
import { LibnutDriver } from "./LibnutDriver"
import { loadLibnut } from "./libnutLoader"

/**
 * One DesktopSession per task. The session holds screenshot geometry, so it must
 * live as long as the task's conversation with the model.
 *
 * Keyed by an opaque owner object (the Task) so this module has no dependency on Task.
 */

export type DesktopSessionFactory = (extensionPath: string) => DesktopSession

const defaultFactory: DesktopSessionFactory = (extensionPath) =>
	new DesktopSession(new LibnutDriver(loadLibnut(extensionPath)))

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
