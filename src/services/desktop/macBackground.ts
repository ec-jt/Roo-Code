import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

/**
 * macOS background control: act on one window without moving the user's
 * cursor or changing the frontmost app. Used as a fallback when the user is
 * busy with the mouse and keyboard.
 *
 * - captureWindow: `screencapture -l <windowId>` captures one window, even when
 *   it is covered by other windows. Needs Screen Recording permission.
 * - typeInWindow: sets AXSelectedText on the focused element of the window's
 *   app through Accessibility. The text is inserted at that app's caret and
 *   the app is not activated. Works for native text fields; some apps
 *   (browsers, Electron) ignore it.
 *
 * Window ids are CGWindowNumber values, which are also the libnut window handles.
 */

export interface WindowCapture {
	dataUrl: string
	width: number
	height: number
}

export interface BackgroundControl {
	captureWindow(windowId: number, maxSize: number): Promise<WindowCapture>
	typeInWindow(windowId: number, text: string): Promise<void>
}

type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>

const defaultExec: Exec = (file, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(String(stderr || error.message).trim()))
				return
			}
			resolve(String(stdout))
		})
	})

/** JXA: find the owner pid of a window id and insert text at the app's focused element. */
export const TYPE_IN_WINDOW_SCRIPT = `ObjC.import('CoreGraphics');
function run(argv) {
  const windowId = Number(argv[0]);
  const text = argv[1];
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
  let pid = 0;
  for (let i = 0; i < list.count; i++) {
    const d = list.objectAtIndex(i);
    if (ObjC.unwrap(d.objectForKey('kCGWindowNumber')) === windowId) {
      pid = ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID'));
      break;
    }
  }
  if (!pid) return JSON.stringify({ ok: false, error: 'window not found' });
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  let focused;
  try { focused = proc.attributes.byName('AXFocusedUIElement').value(); } catch (e) { focused = null; }
  if (!focused) return JSON.stringify({ ok: false, error: 'no focused text element' });
  try { focused.attributes.byName('AXSelectedText').value = text; }
  catch (e) { return JSON.stringify({ ok: false, error: 'the focused element does not accept text' }); }
  return JSON.stringify({ ok: true });
}`

function parsePngSize(png: Buffer): { width: number; height: number } {
	// PNG IHDR: width at byte 16, height at byte 20 (big-endian).
	if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") {
		throw new Error("The window capture is not a PNG image.")
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

export function createMacBackgroundControl(exec: Exec = defaultExec): BackgroundControl {
	return {
		async captureWindow(windowId, maxSize) {
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-window-"))
			const file = path.join(dir, "window.png")
			try {
				// -x: no sound, -o: no window shadow, -l: one window by id.
				await exec("/usr/sbin/screencapture", ["-x", "-o", `-l${windowId}`, file], 10_000)
				await exec("/usr/bin/sips", ["-Z", String(maxSize), file], 10_000)
				const png = await fs.readFile(file)
				const { width, height } = parsePngSize(png)
				return { dataUrl: `data:image/png;base64,${png.toString("base64")}`, width, height }
			} finally {
				await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
			}
		},

		async typeInWindow(windowId, text) {
			const out = await exec(
				"/usr/bin/osascript",
				["-l", "JavaScript", "-e", TYPE_IN_WINDOW_SCRIPT, String(windowId), text],
				15_000,
			)
			let result: { ok?: boolean; error?: string } = {}
			try {
				result = JSON.parse(out.trim())
			} catch {
				throw new Error(`Unexpected output from the Accessibility script: ${out.trim().slice(0, 200)}`)
			}
			if (!result.ok) {
				throw new Error(result.error ?? "background typing failed")
			}
		},
	}
}
