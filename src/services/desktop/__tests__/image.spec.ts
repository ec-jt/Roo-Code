import * as zlib from "zlib"

import { computeTargetSize, crc32, downscaleToRgb, encodePngRgb } from "../image"
import type { RawCapture } from "../DesktopDriver"

function bgraCapture(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number],
	padding = 0,
): RawCapture {
	const byteWidth = width * 4 + padding
	const image = Buffer.alloc(byteWidth * height, 0xee)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixel(x, y)
			const p = y * byteWidth + x * 4
			image[p] = b
			image[p + 1] = g
			image[p + 2] = r
			image[p + 3] = 255
		}
	}
	return { width, height, byteWidth, bytesPerPixel: 4, image }
}

/** Minimal PNG decoder for colour type 2, filter 0 (what encodePngRgb writes). */
function decodePng(png: Buffer) {
	expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
	let offset = 8
	let width = 0
	let height = 0
	const idat: Buffer[] = []
	const types: string[] = []
	while (offset < png.length) {
		const length = png.readUInt32BE(offset)
		const type = png.toString("ascii", offset + 4, offset + 8)
		const data = png.subarray(offset + 8, offset + 8 + length)
		const crc = png.readUInt32BE(offset + 8 + length)
		expect(crc).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)))
		types.push(type)
		if (type === "IHDR") {
			width = data.readUInt32BE(0)
			height = data.readUInt32BE(4)
			expect([...data.subarray(8)]).toEqual([8, 2, 0, 0, 0])
		}
		if (type === "IDAT") idat.push(data)
		offset += 12 + length
	}
	const raw = zlib.inflateSync(Buffer.concat(idat))
	const rgb = Buffer.alloc(width * height * 3)
	for (let y = 0; y < height; y++) {
		expect(raw[y * (width * 3 + 1)]).toBe(0)
		raw.copy(rgb, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1))
	}
	return { width, height, rgb, types }
}

describe("computeTargetSize", () => {
	it("downscales a Retina capture to fit the limits and keeps the aspect ratio", () => {
		expect(computeTargetSize(3024, 1964, 1280, 800)).toEqual({ width: 1232, height: 800 })
	})

	it("never upscales", () => {
		expect(computeTargetSize(800, 600, 1280, 800)).toEqual({ width: 800, height: 600 })
	})
})

describe("crc32", () => {
	it("matches the standard check value", () => {
		expect(crc32(Buffer.from("123456789", "ascii"))).toBe(0xcbf43926)
	})
})

describe("downscaleToRgb", () => {
	it("converts BGRA to RGB at the same size and ignores row padding", () => {
		const capture = bgraCapture(2, 2, (x, y) => [x * 100, y * 100, 7], 12)
		expect([...downscaleToRgb(capture, 2, 2)]).toEqual([0, 0, 7, 100, 0, 7, 0, 100, 7, 100, 100, 7])
	})

	it("averages each block of source pixels (2x downscale)", () => {
		// 4x2 capture: left 2x2 block alternates 0/200 red, right block is solid 50 green.
		const capture = bgraCapture(4, 2, (x, y) => (x < 2 ? [(x + y) % 2 ? 200 : 0, 0, 0] : [0, 50, 0]))
		expect([...downscaleToRgb(capture, 2, 1)]).toEqual([100, 0, 0, 0, 50, 0])
	})

	it("rejects captures with fewer than 3 bytes per pixel", () => {
		expect(() =>
			downscaleToRgb({ width: 1, height: 1, byteWidth: 2, bytesPerPixel: 2, image: Buffer.alloc(2) }, 1, 1),
		).toThrow(/bytes per pixel/)
	})

	it("rejects a buffer that is too small", () => {
		expect(() =>
			downscaleToRgb({ width: 2, height: 2, byteWidth: 8, bytesPerPixel: 4, image: Buffer.alloc(8) }, 1, 1),
		).toThrow(/smaller/)
	})
})

describe("encodePngRgb", () => {
	it("round-trips pixels through a valid PNG", () => {
		const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90])
		const decoded = decodePng(encodePngRgb(rgb, 3, 2))
		expect(decoded).toMatchObject({ width: 3, height: 2, types: ["IHDR", "IDAT", "IEND"] })
		expect([...decoded.rgb]).toEqual([...rgb])
	})

	it("rejects a buffer whose length does not match the size", () => {
		expect(() => encodePngRgb(Buffer.alloc(5), 2, 1)).toThrow(/does not match/)
	})
})
