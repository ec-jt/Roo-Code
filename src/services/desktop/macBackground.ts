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

/** A UI element in screen points (logical coordinates, same space as mouse input). */
export interface WindowElement {
	role: string
	name: string
	x?: number
	y?: number
}

export interface BackgroundControl {
	captureWindow(windowId: number, maxSize: number): Promise<WindowCapture>
	typeInWindow(windowId: number, text: string): Promise<void>
	/** List interactive elements (buttons, fields, menus) of a window through Accessibility. */
	listElements(windowId: number): Promise<WindowElement[]>
	/** Press (AXPress) the element whose name matches, without moving the pointer. Returns the element pressed. */
	pressElement(windowId: number, name: string): Promise<WindowElement>
}

/** Full-screen capture that returns an already scaled, compressed image. */
export type FastScreenCapture = (width: number, height: number) => Promise<WindowCapture>

/** JPEG quality for screenshots sent to the model (sips formatOptions, 0-100). */
export const SCREENSHOT_JPEG_QUALITY = 70

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

/** Shared JXA prelude: find the Accessibility window for a CGWindow id. */
const FIND_AX_WINDOW = `ObjC.import('CoreGraphics');
function findWindow(windowId) {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
  let pid = 0, title = '';
  for (let i = 0; i < list.count; i++) {
    const d = list.objectAtIndex(i);
    if (ObjC.unwrap(d.objectForKey('kCGWindowNumber')) === windowId) {
      pid = ObjC.unwrap(d.objectForKey('kCGWindowOwnerPID'));
      const n = d.objectForKey('kCGWindowName');
      title = n.isNil() ? '' : ObjC.unwrap(n);
      break;
    }
  }
  if (!pid) return null;
  const proc = Application('System Events').processes.whose({ unixId: pid })[0];
  const wins = proc.windows();
  return wins.find(w => { try { return w.name() === title } catch (e) { return false } }) || wins[0] || null;
}
const ROLES = { AXButton:1, AXTextField:1, AXTextArea:1, AXCheckBox:1, AXRadioButton:1, AXPopUpButton:1, AXMenuButton:1, AXLink:1, AXComboBox:1, AXSearchField:1, AXTab:1, AXSlider:1, AXMenuItem:1, AXDisclosureTriangle:1 };
function describe(el) {
  let role; try { role = el.role() } catch (e) { return null }
  if (!ROLES[role]) return null;
  let name = '';
  for (const g of ['description', 'title', 'name', 'help']) { try { const v = el[g](); if (v) { name = String(v); break } } catch (e) {} }
  if (!name) { try { const v = el.value(); if (typeof v === 'string' && v) name = v.slice(0, 60) } catch (e) {} }
  let x, y; try { const p = el.position(), s = el.size(); x = Math.round(p[0] + s[0] / 2); y = Math.round(p[1] + s[1] / 2) } catch (e) {}
  return { role: role.replace(/^AX/, ''), name, x, y };
}
function collect(win, limit, budgetMs) {
  const start = Date.now(); const out = [];
  for (const el of win.entireContents()) {
    if (out.length >= limit || Date.now() - start > budgetMs) break;
    const info = describe(el); if (info) out.push({ el, info });
  }
  return out;
}`

/** JXA: list interactive elements of a window. */
export const LIST_ELEMENTS_SCRIPT = `${FIND_AX_WINDOW}
function run(argv) {
  const win = findWindow(Number(argv[0]));
  if (!win) return JSON.stringify({ ok: false, error: 'window not found' });
  return JSON.stringify({ ok: true, elements: collect(win, 150, 5000).map(e => e.info) });
}`

/** JXA: press the best-matching element (exact name first, then substring; case-insensitive). */
export const PRESS_ELEMENT_SCRIPT = `${FIND_AX_WINDOW}
function run(argv) {
  const win = findWindow(Number(argv[0]));
  if (!win) return JSON.stringify({ ok: false, error: 'window not found' });
  const needle = String(argv[1]).trim().toLowerCase();
  const all = collect(win, 400, 6000).filter(e => e.info.name);
  const exact = all.filter(e => e.info.name.toLowerCase() === needle);
  const partial = all.filter(e => e.info.name.toLowerCase().includes(needle));
  const matches = exact.length ? exact : partial;
  if (matches.length === 0) return JSON.stringify({ ok: false, error: 'no element named "' + argv[1] + '"' });
  if (matches.length > 1 && !exact.length) {
    return JSON.stringify({ ok: false, error: '"' + argv[1] + '" matches ' + matches.length + ' elements: ' + matches.slice(0, 8).map(m => m.info.role + ' "' + m.info.name + '"').join(', ') + '. Use the full name.' });
  }
  const target = matches[0];
  try { target.el.actions.byName('AXPress').perform(); }
  catch (e) {
    try { target.el.focused = true; } catch (e2) { return JSON.stringify({ ok: false, error: 'the element cannot be pressed' }); }
  }
  return JSON.stringify({ ok: true, element: target.info });
}`

function parseScriptResult<T extends object>(out: string): T & { ok?: boolean; error?: string } {
	try {
		return JSON.parse(out.trim())
	} catch {
		throw new Error(`Unexpected output from the Accessibility script: ${out.trim().slice(0, 200)}`)
	}
}

function parsePngSize(png: Buffer): { width: number; height: number } {
	// PNG IHDR: width at byte 16, height at byte 20 (big-endian).
	if (png.length < 24 || png.toString("ascii", 1, 4) !== "PNG") {
		throw new Error("The window capture is not a PNG image.")
	}
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function parseJpegSize(jpeg: Buffer): { width: number; height: number } {
	// Walk JPEG segments to the first SOFn marker, which holds height and width.
	if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
		throw new Error("The screen capture is not a JPEG image.")
	}
	let offset = 2
	while (offset + 9 < jpeg.length) {
		if (jpeg[offset] !== 0xff) {
			offset++
			continue
		}
		const marker = jpeg[offset + 1]
		const length = jpeg.readUInt16BE(offset + 2)
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
		if (isSof) {
			return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) }
		}
		offset += 2 + length
	}
	throw new Error("Could not read the JPEG image size.")
}

/**
 * macOS: capture the main display with the system tool and scale it to exactly
 * width x height as JPEG. About 3x faster than encoding a PNG in JavaScript,
 * and the image is several times smaller.
 */
export function createMacFastScreenCapture(exec: Exec = defaultExec): FastScreenCapture {
	return async (width, height) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-screen-"))
		const file = path.join(dir, "screen.jpg")
		try {
			// -x: no sound, -m: main display only (matches mouse coordinates), -t: format.
			await exec("/usr/sbin/screencapture", ["-x", "-m", "-t", "jpg", file], 10_000)
			await exec(
				"/usr/bin/sips",
				["-z", String(height), String(width), "-s", "formatOptions", String(SCREENSHOT_JPEG_QUALITY), file],
				10_000,
			)
			const jpeg = await fs.readFile(file)
			const size = parseJpegSize(jpeg)
			return { dataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`, ...size }
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
		}
	}
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
			const result = parseScriptResult(out)
			if (!result.ok) {
				throw new Error(result.error ?? "background typing failed")
			}
		},

		async listElements(windowId) {
			const out = await exec(
				"/usr/bin/osascript",
				["-l", "JavaScript", "-e", LIST_ELEMENTS_SCRIPT, String(windowId)],
				15_000,
			)
			const result = parseScriptResult<{ elements?: WindowElement[] }>(out)
			if (!result.ok) {
				throw new Error(result.error ?? "listing elements failed")
			}
			return result.elements ?? []
		},

		async pressElement(windowId, name) {
			const out = await exec(
				"/usr/bin/osascript",
				["-l", "JavaScript", "-e", PRESS_ELEMENT_SCRIPT, String(windowId), name],
				15_000,
			)
			const result = parseScriptResult<{ element?: WindowElement }>(out)
			if (!result.ok || !result.element) {
				throw new Error(result.error ?? "pressing the element failed")
			}
			return result.element
		},
	}
}
