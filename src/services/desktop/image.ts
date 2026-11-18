import * as zlib from "zlib"

import type { RawCapture } from "./DesktopDriver"

/**
 * Screenshot processing with no image library: box-filter downscale of a BGR(A)
 * capture to RGB, then PNG encoding with Node's zlib.
 */

export interface Size {
	width: number
	height: number
}

/** Fit inside maxWidth x maxHeight, keep aspect ratio, never upscale. */
export function computeTargetSize(width: number, height: number, maxWidth: number, maxHeight: number): Size {
	const scale = Math.min(1, maxWidth / width, maxHeight / height)
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	}
}

/**
 * Downscale a BGR(A) capture to packed RGB using an area-average (box) filter.
 * Each destination pixel averages the block of source pixels it covers, which keeps
 * small UI text more legible than nearest-neighbour sampling.
 */
export function downscaleToRgb(capture: RawCapture, targetWidth: number, targetHeight: number): Buffer {
	const { width: sw, height: sh, byteWidth, bytesPerPixel: bpp, image } = capture

	if (bpp < 3) {
		throw new Error(`Unsupported capture format: ${bpp} bytes per pixel`)
	}
	if (image.length < byteWidth * sh) {
		throw new Error("Capture buffer is smaller than byteWidth * height")
	}

	const tw = Math.max(1, Math.min(targetWidth, sw))
	const th = Math.max(1, Math.min(targetHeight, sh))
	const out = Buffer.alloc(tw * th * 3)

	const xStart = new Int32Array(tw)
	const xEnd = new Int32Array(tw)
	for (let x = 0; x < tw; x++) {
		const start = Math.floor((x * sw) / tw)
		xStart[x] = start
		xEnd[x] = Math.min(sw, Math.max(start + 1, Math.floor(((x + 1) * sw) / tw)))
	}

	let o = 0
	for (let y = 0; y < th; y++) {
		const y0 = Math.floor((y * sh) / th)
		const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor(((y + 1) * sh) / th)))

		for (let x = 0; x < tw; x++) {
			const x0 = xStart[x]
			const x1 = xEnd[x]
			let r = 0
			let g = 0
			let b = 0

			for (let sy = y0; sy < y1; sy++) {
				let p = sy * byteWidth + x0 * bpp
				for (let sx = x0; sx < x1; sx++) {
					b += image[p]
					g += image[p + 1]
					r += image[p + 2]
					p += bpp
				}
			}

			const count = (y1 - y0) * (x1 - x0)
			out[o++] = Math.round(r / count)
			out[o++] = Math.round(g / count)
			out[o++] = Math.round(b / count)
		}
	}

	return out
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		}
		table[n] = c >>> 0
	}
	return table
})()

/** CRC-32 (IEEE). Implemented here because zlib.crc32 needs Node 22.2+. */
export function crc32(buf: Buffer): number {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) {
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	}
	return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(typeAndData))
	return Buffer.concat([length, typeAndData, crc])
}

/** Encode packed 8-bit RGB as a PNG (colour type 2, filter type None on every row). */
export function encodePngRgb(rgb: Buffer, width: number, height: number, level = 6): Buffer {
	const stride = width * 3
	if (rgb.length !== stride * height) {
		throw new Error(`RGB buffer length ${rgb.length} does not match ${width}x${height}`)
	}

	const raw = Buffer.alloc((stride + 1) * height)
	for (let y = 0; y < height; y++) {
		const rowStart = y * (stride + 1)
		raw[rowStart] = 0 // filter: None
		rgb.copy(raw, rowStart + 1, y * stride, (y + 1) * stride)
	}

	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(width, 0)
	ihdr.writeUInt32BE(height, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // colour type: RGB
	ihdr[10] = 0 // compression
	ihdr[11] = 0 // filter method
	ihdr[12] = 0 // interlace: none

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw, { level })),
		pngChunk("IEND", Buffer.alloc(0)),
	])
}
