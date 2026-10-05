import * as fs from "fs/promises"
import { constants } from "fs"
import * as path from "path"

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function relativeDestination(filePath: string, cwd: string): string {
	const relative = path.relative(path.resolve(cwd), path.resolve(cwd, filePath))
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Screenshot path "${filePath}" must name a file inside the workspace.`)
	}
	return relative
}

/** Reject links even when they target the workspace, so aliases cannot bypass ignore or mode rules. */
export async function validateScreenshotPath(filePath: string, cwd: string): Promise<string> {
	const relative = relativeDestination(filePath, cwd)
	const root = await fs.realpath(cwd)
	const segments = relative.split(path.sep)
	let current = root
	for (let index = 0; index < segments.length; index++) {
		current = path.join(current, segments[index])
		try {
			const stat = await fs.lstat(current)
			if (stat.isSymbolicLink()) throw new Error(`Screenshot path cannot contain symbolic links: ${current}`)
			if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) {
				throw new Error(`Screenshot path must use directories and a regular, non-hard-linked file: ${current}`)
			}
			if (!samePath(await fs.realpath(current), current)) {
				throw new Error(`Screenshot path changed during validation: ${current}`)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			break
		}
	}
	return path.join(root, relative)
}

/** Write through a checked handle, never through Puppeteer's unchecked path writer. */
export async function writeScreenshot(
	filePath: string,
	cwd: string,
	data: Uint8Array,
	validateAccess?: () => Promise<void>,
): Promise<void> {
	await validateAccess?.()
	const destination = await validateScreenshotPath(filePath, cwd)
	const revalidate = async () => {
		if (!samePath(await validateScreenshotPath(filePath, cwd), destination)) {
			throw new Error("Screenshot workspace changed during write validation.")
		}
	}
	// Create one directory at a time, rechecking existing ancestors before each mutation.
	const root = await fs.realpath(cwd)
	let directory = root
	for (const segment of path.relative(root, path.dirname(destination)).split(path.sep).filter(Boolean)) {
		await revalidate()
		directory = path.join(directory, segment)
		await fs.mkdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error
		})
	}
	await validateAccess?.()
	await revalidate()
	// O_NOFOLLOW closes the final-component symlink race on platforms that support it.
	// Do not truncate until both the open handle and the path have been checked again.
	const handle = await fs.open(
		destination,
		constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		0o600,
	)
	try {
		await revalidate()
		const opened = await handle.stat()
		const current = await fs.lstat(destination)
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) {
			throw new Error("Screenshot destination changed during write validation.")
		}
		await validateAccess?.()
		await handle.truncate(0)
		await handle.writeFile(data)
	} finally {
		await handle.close()
	}
}
