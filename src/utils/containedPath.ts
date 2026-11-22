import * as fs from "fs"
import * as path from "path"

/** Upper bound on symbolic links followed while resolving one path (same order as the OS limit). */
const MAX_LINK_HOPS = 40

/**
 * Real path of `target`, also when it does not exist yet.
 *
 * - `..` and `.` are normalised first (`path.resolve`), exactly as the file tools do before they write.
 * - The nearest existing ancestor is resolved with `fs.realpathSync.native`, so symbolic links in any
 *   existing part of the path are followed. The missing tail is appended unchanged.
 * - A dangling symbolic link is followed to its target, because writing through it creates the target.
 *
 * Never throws.
 */
export function resolveRealPath(target: string): string {
	let current = path.resolve(target)
	const tail: string[] = []
	let hops = 0
	for (;;) {
		try {
			const real = fs.realpathSync.native(current)
			return tail.length ? path.join(real, ...tail) : real
		} catch {
			// Missing, dangling link or loop: handled below.
		}
		let isLink = false
		try {
			isLink = fs.lstatSync(current).isSymbolicLink()
		} catch {
			isLink = false
		}
		if (isLink && hops < MAX_LINK_HOPS) {
			hops++
			try {
				current = path.resolve(path.dirname(current), fs.readlinkSync(current))
				continue
			} catch {
				// Unreadable link: fall back to walking up.
			}
		}
		const parent = path.dirname(current)
		if (parent === current) return tail.length ? path.join(current, ...tail) : current
		tail.unshift(path.basename(current))
		current = parent
	}
}

/** True when the real path of `target` is `root` or inside it (both resolved with resolveRealPath). */
export function isPathInsideRealRoot(target: string, root: string): boolean {
	if (!root) return false
	const realRoot = resolveRealPath(root)
	const realTarget = resolveRealPath(target)
	const relative = path.relative(realRoot, realTarget)
	if (relative === "") return true
	if (path.isAbsolute(relative)) return false
	return relative !== ".." && !relative.startsWith(`..${path.sep}`)
}
