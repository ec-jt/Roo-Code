import type { FileHandle } from "fs/promises"
import * as fs from "fs/promises"
import * as zlib from "zlib"

import { updateError } from "./errors"

/**
 * Bounded, read-only ZIP inspection used to validate a downloaded VSIX before it
 * is offered to the user.
 *
 * Design rules:
 * - Nothing is ever extracted to disk. Only individual entries that are needed
 *   (the VSIX manifest) are inflated, with a hard output cap.
 * - Every value that comes from the archive is treated as untrusted input and
 *   validated: names, sizes, compression method, flags, entry count, and the
 *   central directory layout.
 * - The central directory is used as the source of truth, then every local file
 *   header is re-read and cross-checked, which rejects archives whose local and
 *   central metadata disagree (a common way to smuggle content past scanners).
 * - Archives that need ZIP64, are encrypted, use an unexpected compression
 *   method, contain symlinks, duplicate names, traversal paths, or look like
 *   compression bombs are rejected instead of being interpreted.
 */

const EOCD_SIGNATURE = 0x06054b50
const EOCD_MIN_LENGTH = 22
const MAX_EOCD_COMMENT_BYTES = 0xffff
const MAX_EOCD_SCAN_BYTES = EOCD_MIN_LENGTH + MAX_EOCD_COMMENT_BYTES

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const CENTRAL_DIRECTORY_HEADER_LENGTH = 46
const LOCAL_FILE_SIGNATURE = 0x04034b50
const LOCAL_FILE_HEADER_LENGTH = 30

const ZIP64_SENTINEL_16 = 0xffff
const ZIP64_SENTINEL_32 = 0xffffffff

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const FLAG_ENCRYPTED = 0x0001
const FLAG_DATA_DESCRIPTOR = 0x0008
const FLAG_PATCHED_DATA = 0x0020
const FLAG_STRONG_ENCRYPTION = 0x0040

const UNIX_FILE_TYPE_MASK = 0xf000
const UNIX_SYMLINK_TYPE = 0xa000

/** Ratios are only enforced above this size, so tiny highly compressible files are not rejected. */
const RATIO_CHECK_MIN_UNCOMPRESSED_BYTES = 1024 * 1024

export interface ZipInspectionLimits {
	maxEntries: number
	maxCentralDirectoryBytes: number
	maxEntryCompressedBytes: number
	maxEntryUncompressedBytes: number
	maxTotalUncompressedBytes: number
	maxCompressionRatio: number
	maxNameBytes: number
}

/**
 * Defaults are calibrated against a real Roo Code VSIX (v4.2.24): 1763 entries,
 * 31.5 MiB compressed, 151.8 MiB uncompressed, max entry 18.8 MiB, max ratio
 * 18.8, all entries deflated with the "data descriptor" flag set.
 */
export const DEFAULT_ZIP_LIMITS: ZipInspectionLimits = {
	maxEntries: 20000,
	maxCentralDirectoryBytes: 16 * 1024 * 1024,
	maxEntryCompressedBytes: 128 * 1024 * 1024,
	maxEntryUncompressedBytes: 256 * 1024 * 1024,
	maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
	maxCompressionRatio: 200,
	maxNameBytes: 1024,
}

export interface ZipEntry {
	name: string
	method: number
	flags: number
	crc32: number
	compressedSize: number
	uncompressedSize: number
	localHeaderOffset: number
	externalAttributes: number
	internalAttributes: number
}

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let index = 0; index < 256; index++) {
		let value = index
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		}
		table[index] = value >>> 0
	}
	return table
})()

export function crc32(buffer: Buffer): number {
	let crc = 0xffffffff
	for (let index = 0; index < buffer.length; index++) {
		crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0
}

async function readExactly(handle: FileHandle, start: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length)
	let read = 0
	while (read < length) {
		const result = await handle.read(buffer, read, length - read, start + read)
		if (result.bytesRead <= 0) {
			throw updateError("UNSAFE_ARCHIVE", "Archive ended before the declared structure was read.")
		}
		read += result.bytesRead
	}
	return buffer
}

function assertSafeEntryName(name: string, limits: ZipInspectionLimits): void {
	if (name.length === 0) {
		throw updateError("UNSAFE_ARCHIVE", "Archive contains an entry with an empty name.")
	}
	if (Buffer.byteLength(name, "utf8") > limits.maxNameBytes) {
		throw updateError("UNSAFE_ARCHIVE", "Archive entry name is longer than the supported limit.")
	}
	if (name.includes("\u0000") || name.includes("\ufffd")) {
		throw updateError("UNSAFE_ARCHIVE", "Archive entry name is not valid text.")
	}
	if (name.includes("\\")) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry name uses a backslash separator: ${name}`)
	}
	if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry name is absolute: ${name}`)
	}
	for (const segment of name.split("/")) {
		if (segment === ".." || segment === ".") {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry name contains a traversal segment: ${name}`)
		}
	}
}

function assertSupportedEntryFields(entry: ZipEntry, limits: ZipInspectionLimits): void {
	if ((entry.flags & FLAG_ENCRYPTED) !== 0 || (entry.flags & FLAG_STRONG_ENCRYPTION) !== 0) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry is encrypted: ${entry.name}`)
	}
	if ((entry.flags & FLAG_PATCHED_DATA) !== 0) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry uses patched compressed data: ${entry.name}`)
	}
	if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
		throw updateError(
			"UNSAFE_ARCHIVE",
			`Archive entry uses unsupported compression method ${entry.method}: ${entry.name}`,
		)
	}
	const unixMode = entry.externalAttributes >>> 16
	if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry is a symbolic link: ${entry.name}`)
	}
	if (entry.compressedSize > limits.maxEntryCompressedBytes) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry is larger than the supported limit: ${entry.name}`)
	}
	if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry expands beyond the supported limit: ${entry.name}`)
	}
	if (entry.uncompressedSize > 0) {
		if (entry.compressedSize === 0) {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry declares data but stores no bytes: ${entry.name}`)
		}
		if (
			entry.uncompressedSize > RATIO_CHECK_MIN_UNCOMPRESSED_BYTES &&
			entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
		) {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry has a suspicious compression ratio: ${entry.name}`)
		}
	}
}

function locateEndOfCentralDirectory(tail: Buffer, tailStart: number, fileSize: number): number {
	for (let offset = tail.length - EOCD_MIN_LENGTH; offset >= 0; offset--) {
		if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) {
			continue
		}
		const commentLength = tail.readUInt16LE(offset + 20)
		if (tailStart + offset + EOCD_MIN_LENGTH + commentLength !== fileSize) {
			continue
		}
		return offset
	}
	throw updateError("UNSAFE_ARCHIVE", "Archive end of central directory record was not found.")
}

/**
 * Reads and validates the central directory of a ZIP archive without extracting
 * anything. Throws `UNSAFE_ARCHIVE` when the archive is truncated, malformed,
 * uses ZIP64, contains unsafe names, symlinks, duplicates, or resize bombs.
 */
export async function listZipEntries(
	filePath: string,
	limits: ZipInspectionLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZipEntry[]> {
	const handle = await fs.open(filePath, "r")
	try {
		const stats = await handle.stat()
		const fileSize = stats.size
		if (fileSize < EOCD_MIN_LENGTH) {
			throw updateError("UNSAFE_ARCHIVE", "Archive is too small to be a ZIP container.")
		}

		const tailLength = Math.min(fileSize, MAX_EOCD_SCAN_BYTES)
		const tailStart = fileSize - tailLength
		const tail = await readExactly(handle, tailStart, tailLength)
		const eocdOffset = tailStart + locateEndOfCentralDirectory(tail, tailStart, fileSize)

		const diskNumber = tail.readUInt16LE(eocdOffset - tailStart + 4)
		const centralDirectoryDisk = tail.readUInt16LE(eocdOffset - tailStart + 6)
		const entriesOnDisk = tail.readUInt16LE(eocdOffset - tailStart + 8)
		const totalEntries = tail.readUInt16LE(eocdOffset - tailStart + 10)
		const centralDirectorySize = tail.readUInt32LE(eocdOffset - tailStart + 12)
		const centralDirectoryOffset = tail.readUInt32LE(eocdOffset - tailStart + 16)

		if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
			throw updateError("UNSAFE_ARCHIVE", "Archive spans multiple disks, which is not supported.")
		}
		if (
			totalEntries === ZIP64_SENTINEL_16 ||
			centralDirectorySize === ZIP64_SENTINEL_32 ||
			centralDirectoryOffset === ZIP64_SENTINEL_32
		) {
			throw updateError("UNSAFE_ARCHIVE", "ZIP64 archives are not supported.")
		}
		if (totalEntries === 0) {
			throw updateError("UNSAFE_ARCHIVE", "Archive contains no entries.")
		}
		if (totalEntries > limits.maxEntries) {
			throw updateError("UNSAFE_ARCHIVE", `Archive contains more than ${limits.maxEntries} entries.`)
		}
		if (centralDirectorySize > limits.maxCentralDirectoryBytes) {
			throw updateError("UNSAFE_ARCHIVE", "Archive central directory is larger than the supported limit.")
		}
		if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
			throw updateError("UNSAFE_ARCHIVE", "Archive central directory is not contiguous with its end record.")
		}

		const centralDirectory = await readExactly(handle, centralDirectoryOffset, centralDirectorySize)
		const entries: ZipEntry[] = []
		const seenNames = new Set<string>()
		let totalUncompressed = 0
		let cursor = 0

		for (let index = 0; index < totalEntries; index++) {
			if (cursor + CENTRAL_DIRECTORY_HEADER_LENGTH > centralDirectory.length) {
				throw updateError("UNSAFE_ARCHIVE", "Archive central directory is truncated.")
			}
			if (centralDirectory.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
				throw updateError("UNSAFE_ARCHIVE", "Archive central directory contains an unexpected record.")
			}
			const flags = centralDirectory.readUInt16LE(cursor + 8)
			const method = centralDirectory.readUInt16LE(cursor + 10)
			const crc = centralDirectory.readUInt32LE(cursor + 16)
			const compressedSize = centralDirectory.readUInt32LE(cursor + 20)
			const uncompressedSize = centralDirectory.readUInt32LE(cursor + 24)
			const nameLength = centralDirectory.readUInt16LE(cursor + 28)
			const extraLength = centralDirectory.readUInt16LE(cursor + 30)
			const entryCommentLength = centralDirectory.readUInt16LE(cursor + 32)
			const diskStart = centralDirectory.readUInt16LE(cursor + 34)
			const internalAttributes = centralDirectory.readUInt16LE(cursor + 36)
			const externalAttributes = centralDirectory.readUInt32LE(cursor + 38)
			const localHeaderOffset = centralDirectory.readUInt32LE(cursor + 42)

			if (
				compressedSize === ZIP64_SENTINEL_32 ||
				uncompressedSize === ZIP64_SENTINEL_32 ||
				localHeaderOffset === ZIP64_SENTINEL_32
			) {
				throw updateError("UNSAFE_ARCHIVE", "ZIP64 archives are not supported.")
			}
			if (diskStart !== 0) {
				throw updateError("UNSAFE_ARCHIVE", "Archive entry refers to another disk, which is not supported.")
			}
			if (nameLength === 0) {
				throw updateError("UNSAFE_ARCHIVE", "Archive contains an entry with an empty name.")
			}
			const entryLength = CENTRAL_DIRECTORY_HEADER_LENGTH + nameLength + extraLength + entryCommentLength
			if (cursor + entryLength > centralDirectory.length) {
				throw updateError("UNSAFE_ARCHIVE", "Archive entry metadata is truncated.")
			}

			const nameStart = cursor + CENTRAL_DIRECTORY_HEADER_LENGTH
			const name = centralDirectory.subarray(nameStart, nameStart + nameLength).toString("utf8")
			assertSafeEntryName(name, limits)
			if (seenNames.has(name) || seenNames.has(name.toLowerCase())) {
				throw updateError("UNSAFE_ARCHIVE", `Archive contains a duplicate entry name: ${name}`)
			}
			seenNames.add(name)

			const entry: ZipEntry = {
				name,
				method,
				flags,
				crc32: crc,
				compressedSize,
				uncompressedSize,
				localHeaderOffset,
				externalAttributes,
				internalAttributes,
			}
			assertSupportedEntryFields(entry, limits)
			totalUncompressed += uncompressedSize
			if (totalUncompressed > limits.maxTotalUncompressedBytes) {
				throw updateError("UNSAFE_ARCHIVE", "Archive expands beyond the supported total size.")
			}
			entries.push(entry)
			cursor += entryLength
		}

		if (cursor !== centralDirectory.length) {
			throw updateError("UNSAFE_ARCHIVE", "Archive central directory has trailing bytes.")
		}

		for (const entry of entries) {
			await verifyLocalHeader(handle, entry, centralDirectoryOffset)
		}

		return entries
	} finally {
		await handle.close()
	}
}

async function verifyLocalHeader(handle: FileHandle, entry: ZipEntry, centralDirectoryOffset: number): Promise<void> {
	if (entry.localHeaderOffset + LOCAL_FILE_HEADER_LENGTH > centralDirectoryOffset) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry points outside the file data area: ${entry.name}`)
	}
	const header = await readExactly(handle, entry.localHeaderOffset, LOCAL_FILE_HEADER_LENGTH)
	if (header.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry is missing its local header: ${entry.name}`)
	}
	if (header.readUInt16LE(6) !== entry.flags || header.readUInt16LE(8) !== entry.method) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry local and central metadata disagree: ${entry.name}`)
	}
	const localNameLength = header.readUInt16LE(26)
	const localExtraLength = header.readUInt16LE(28)
	const nameStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_LENGTH
	const localName = await readExactly(handle, nameStart, localNameLength)
	if (localName.toString("utf8") !== entry.name) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry local and central names disagree: ${entry.name}`)
	}
	const dataStart = nameStart + localNameLength + localExtraLength
	if (dataStart + entry.compressedSize > centralDirectoryOffset) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry data overlaps the central directory: ${entry.name}`)
	}
	if ((entry.flags & FLAG_DATA_DESCRIPTOR) === 0) {
		const localCrc = header.readUInt32LE(14)
		const localCompressedSize = header.readUInt32LE(18)
		const localUncompressedSize = header.readUInt32LE(22)
		if (
			localCrc !== entry.crc32 ||
			localCompressedSize !== entry.compressedSize ||
			localUncompressedSize !== entry.uncompressedSize
		) {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry local and central sizes disagree: ${entry.name}`)
		}
	}
}

/**
 * Reads a single entry into memory. The caller is responsible for picking a
 * small entry (see `inspectVsixManifest`), and the declared uncompressed size is
 * re-checked after inflation.
 */
export async function readZipEntry(filePath: string, entry: ZipEntry, maxBytes: number): Promise<Buffer> {
	if (entry.uncompressedSize > maxBytes) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry expands beyond the supported limit: ${entry.name}`)
	}
	if (entry.compressedSize > maxBytes) {
		throw updateError("UNSAFE_ARCHIVE", `Archive entry is larger than the supported limit: ${entry.name}`)
	}
	const handle = await fs.open(filePath, "r")
	try {
		const header = await readExactly(handle, entry.localHeaderOffset, LOCAL_FILE_HEADER_LENGTH)
		const localNameLength = header.readUInt16LE(26)
		const localExtraLength = header.readUInt16LE(28)
		const dataStart = entry.localHeaderOffset + LOCAL_FILE_HEADER_LENGTH + localNameLength + localExtraLength
		const stored = await readExactly(handle, dataStart, entry.compressedSize)

		let content: Buffer
		if (entry.method === METHOD_STORE) {
			content = stored
		} else {
			try {
				content = zlib.inflateRawSync(stored, { maxOutputLength: entry.uncompressedSize + 1 })
			} catch {
				throw updateError("UNSAFE_ARCHIVE", `Archive entry could not be decompressed safely: ${entry.name}`)
			}
		}
		if (content.length !== entry.uncompressedSize) {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry size does not match its metadata: ${entry.name}`)
		}
		if (crc32(content) !== entry.crc32) {
			throw updateError("UNSAFE_ARCHIVE", `Archive entry checksum does not match its metadata: ${entry.name}`)
		}
		return content
	} finally {
		await handle.close()
	}
}

export const VSIX_MANIFEST_ENTRY = "extension/package.json"
export const VSIX_SIGNATURE_ENTRY = "extension.vsixmanifest"
export const VSIX_MANIFEST_MAX_BYTES = 2 * 1024 * 1024
const VSIX_SIGNATURE_MAX_BYTES = 256 * 1024

export interface VsixIdentity {
	packageName: string
	publisher: string
	version: string
	enginesVscode: string | undefined
	enginesNode: string | undefined
}

export interface ExpectedVsixIdentity {
	packageName: string
	publisher: string
	version: string
}

function findSingleEntry(entries: ZipEntry[], expectedName: string): ZipEntry | undefined {
	const matches = entries.filter((entry) => entry.name.toLowerCase() === expectedName.toLowerCase())
	if (matches.length === 0) {
		return undefined
	}
	if (matches.length > 1) {
		throw updateError("MANIFEST_MISMATCH", `VSIX contains multiple ${expectedName} entries.`)
	}
	if (matches[0].name !== expectedName) {
		throw updateError("MANIFEST_MISMATCH", `VSIX entry ${matches[0].name} does not use the expected name.`)
	}
	return matches[0]
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
	const value = source[key]
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function readVsixSignatureIdentity(xml: string): { id?: string; publisher?: string; version?: string } {
	const identityTag = /<Identity\b[^>]*>/i.exec(xml)
	if (!identityTag) {
		return {}
	}
	const attributes: Record<string, string> = {}
	for (const match of identityTag[0].matchAll(/([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) {
		attributes[match[1].toLowerCase()] = match[2]
	}
	return { id: attributes.id, publisher: attributes.publisher, version: attributes.version }
}

/**
 * Validates the VSIX manifest embedded in the archive against the identity that
 * the updater expects for the selected release tag.
 */
export async function inspectVsixManifest(
	filePath: string,
	expected: ExpectedVsixIdentity,
	limits: ZipInspectionLimits = DEFAULT_ZIP_LIMITS,
): Promise<VsixIdentity> {
	const entries = await listZipEntries(filePath, limits)
	const manifestEntry = findSingleEntry(entries, VSIX_MANIFEST_ENTRY)
	if (!manifestEntry) {
		throw updateError("MANIFEST_MISMATCH", `VSIX does not contain ${VSIX_MANIFEST_ENTRY}.`)
	}
	if (manifestEntry.uncompressedSize > VSIX_MANIFEST_MAX_BYTES) {
		throw updateError("MANIFEST_MISMATCH", "VSIX manifest is larger than the supported limit.")
	}

	const rawManifest = (await readZipEntry(filePath, manifestEntry, VSIX_MANIFEST_MAX_BYTES)).toString("utf8")
	let parsed: unknown
	try {
		parsed = JSON.parse(rawManifest)
	} catch {
		throw updateError("MANIFEST_MISMATCH", "VSIX manifest is not valid JSON.")
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw updateError("MANIFEST_MISMATCH", "VSIX manifest is not a JSON object.")
	}
	const manifest = parsed as Record<string, unknown>

	const packageName = readStringField(manifest, "name")
	const publisher = readStringField(manifest, "publisher")
	const version = readStringField(manifest, "version")
	if (packageName !== expected.packageName) {
		throw updateError("MANIFEST_MISMATCH", `VSIX package name ${packageName ?? "(missing)"} is not expected.`)
	}
	if (publisher === undefined || publisher.toLowerCase() !== expected.publisher.toLowerCase()) {
		throw updateError("MANIFEST_MISMATCH", `VSIX publisher ${publisher ?? "(missing)"} is not expected.`)
	}
	if (version !== expected.version) {
		throw updateError("MANIFEST_MISMATCH", `VSIX version ${version ?? "(missing)"} is not ${expected.version}.`)
	}

	const engines = manifest.engines
	const engineRecord =
		engines && typeof engines === "object" && !Array.isArray(engines) ? (engines as Record<string, unknown>) : {}
	const enginesVscode = readStringField(engineRecord, "vscode")
	const enginesNode = readStringField(engineRecord, "node")

	const signatureEntry = findSingleEntry(entries, VSIX_SIGNATURE_ENTRY)
	if (signatureEntry) {
		if (signatureEntry.uncompressedSize > VSIX_SIGNATURE_MAX_BYTES) {
			throw updateError("MANIFEST_MISMATCH", "VSIX signature manifest is larger than the supported limit.")
		}
		const xml = (await readZipEntry(filePath, signatureEntry, VSIX_SIGNATURE_MAX_BYTES)).toString("utf8")
		const identity = readVsixSignatureIdentity(xml)
		if (
			identity.id !== expected.packageName ||
			identity.publisher?.toLowerCase() !== expected.publisher.toLowerCase() ||
			identity.version !== expected.version
		) {
			throw updateError(
				"MANIFEST_MISMATCH",
				"VSIX signature manifest does not match the expected extension identity.",
			)
		}
	}

	return { packageName, publisher, version, enginesVscode, enginesNode }
}
