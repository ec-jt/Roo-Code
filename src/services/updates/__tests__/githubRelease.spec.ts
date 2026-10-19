// npx vitest run services/updates/__tests__/githubRelease.spec.ts
//
// focused tests:
// - no real network calls (axios is mocked, and vitest.setup.ts disables net connect)
// - no VSIX installation, no settings writes, no JSON artifacts written to the repo

import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { Readable } from "stream"
import * as zlib from "zlib"
import axios from "axios"

import {
	API_ALLOWED_HOSTS,
	DOWNLOAD_ALLOWED_HOSTS,
	MAX_REDIRECTS,
	MAX_RELEASES_JSON_BYTES,
	MAX_SHA256_SIDECAR_BYTES,
	MAX_VSIX_BYTES,
	RELEASES_API_URL,
	RELEASES_MAX_PAGES,
	RELEASES_PER_PAGE,
	UpdateVerificationError,
	assertAllowedUrl,
	buildAssetUrl,
	buildReleaseHtmlUrl,
	checkEngineRange,
	compareStrictVersions,
	createPrivateTempDirectory,
	downloadVerifiedRelease,
	findReleaseUpdate,
	getInstalledVscodeVersion,
	isStrictVersion,
	parseReleaseTag,
	parseSha256Sidecar,
	removeTempDirectory,
	resolveRedirectLocation,
	selectNewestCandidate,
	type ReleaseCandidate,
} from "../githubRelease"
import { DEFAULT_ZIP_LIMITS, inspectVsixManifest, listZipEntries } from "../zipInspect"

vi.mock("axios", () => ({ default: { request: vi.fn() } }))
// Copy native exports into configurable test modules so permission failures can
// be simulated while the existing download tests keep using the real filesystem.
vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))
vi.mock("os", async (importOriginal) => ({ ...(await importOriginal<typeof import("os")>()) }))

const VERSION = "4.2.30"
const VSIX_NAME = `roo-cline-${VERSION}.vsix`
const SIDECAR_NAME = `${VSIX_NAME}.sha256`
const RELEASE_TAG = `v${VERSION}`

const requestMock = vi.mocked(axios.request)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff
	for (const byte of buffer) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit++) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
		}
	}
	return (crc ^ 0xffffffff) >>> 0
}

function sha256(buffer: Buffer): string {
	return crypto.createHash("sha256").update(buffer).digest("hex")
}

interface ZipFixtureEntry {
	name: string
	data?: Buffer | string
	method?: number
	flags?: number
	mode?: number
	compressedSizeOverride?: number
	uncompressedSizeOverride?: number
}

/**
 * Minimal ZIP writer used only by the tests. It mirrors what the real packaging
 * tool produces: deflate, UTF-8 names, and the "data descriptor" flag set on
 * most entries (the real v4.2.24 VSIX has flag 2056 on 1759 of 1763 entries).
 */
function buildZip(entries: ZipFixtureEntry[]): Buffer {
	const parts: Buffer[] = []
	const centralParts: Buffer[] = []
	let offset = 0

	for (const entry of entries) {
		const nameBuffer = Buffer.from(entry.name, "utf8")
		const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8")
		const method = entry.method ?? 8
		const flags = entry.flags ?? 0x0808
		const stored = method === 8 ? zlib.deflateRawSync(data) : data
		const crc = crc32(data)
		const usesDescriptor = (flags & 0x0008) !== 0
		const descriptorLength = usesDescriptor ? 16 : 0

		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(flags, 6)
		local.writeUInt16LE(method, 8)
		local.writeUInt32LE(usesDescriptor ? 0 : crc, 14)
		local.writeUInt32LE(usesDescriptor ? 0 : stored.length, 18)
		local.writeUInt32LE(usesDescriptor ? 0 : data.length, 22)
		local.writeUInt16LE(nameBuffer.length, 26)
		local.writeUInt16LE(0, 28)
		parts.push(local, nameBuffer, stored)

		if (usesDescriptor) {
			const descriptor = Buffer.alloc(descriptorLength)
			descriptor.writeUInt32LE(0x08074b50, 0)
			descriptor.writeUInt32LE(crc, 4)
			descriptor.writeUInt32LE(stored.length, 8)
			descriptor.writeUInt32LE(data.length, 12)
			parts.push(descriptor)
		}

		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(0x031e, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(flags, 8)
		central.writeUInt16LE(method, 10)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(entry.compressedSizeOverride ?? stored.length, 20)
		central.writeUInt32LE(entry.uncompressedSizeOverride ?? data.length, 24)
		central.writeUInt16LE(nameBuffer.length, 28)
		central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
		central.writeUInt32LE(offset, 42)
		centralParts.push(central, nameBuffer)

		offset += local.length + nameBuffer.length + stored.length + descriptorLength
	}

	const centralDirectory = Buffer.concat(centralParts)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(entries.length, 8)
	eocd.writeUInt16LE(entries.length, 10)
	eocd.writeUInt32LE(centralDirectory.length, 12)
	eocd.writeUInt32LE(offset, 16)

	return Buffer.concat([...parts, centralDirectory, eocd])
}

interface VsixFixtureOptions {
	version?: string
	publisher?: string
	name?: string
	engines?: Record<string, string>
	manifestFlags?: number
	manifestMethod?: number
	manifestText?: string
	manifestCompressedSizeOverride?: number
	manifestUncompressedSizeOverride?: number
	signatureVersion?: string
	signaturePublisher?: string
	includeSignature?: boolean
	extraEntries?: ZipFixtureEntry[]
}

function manifestFor(options: VsixFixtureOptions = {}): string {
	return JSON.stringify(
		{
			name: options.name ?? "roo-cline",
			publisher: options.publisher ?? "RooVeterinaryInc",
			version: options.version ?? VERSION,
			engines: options.engines ?? { vscode: "^1.84.0", node: "20.19.2" },
		},
		null,
		"\t",
	)
}

function signatureManifestFor(version: string, publisher: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="roo-cline" Version="${version}" Publisher="${publisher}" /></Metadata></PackageManifest>`
}

function buildVsixFixture(options: VsixFixtureOptions = {}): Buffer {
	const entries: ZipFixtureEntry[] = []
	if (options.includeSignature !== false) {
		entries.push({
			name: "extension.vsixmanifest",
			data: signatureManifestFor(
				options.signatureVersion ?? options.version ?? VERSION,
				options.signaturePublisher ?? "RooVeterinaryInc",
			),
		})
	}
	entries.push({
		name: "extension/package.json",
		data: options.manifestText ?? manifestFor(options),
		method: options.manifestMethod,
		flags: options.manifestFlags,
		compressedSizeOverride: options.manifestCompressedSizeOverride,
		uncompressedSizeOverride: options.manifestUncompressedSizeOverride,
	})
	entries.push({ name: "extension/dist/extension.js", data: "console.log('roo')" })
	entries.push(...(options.extraEntries ?? []))
	return buildZip(entries)
}

function candidateFor(overrides: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
	return {
		version: VERSION,
		tag: RELEASE_TAG,
		url: buildAssetUrl(RELEASE_TAG, VSIX_NAME),
		prerelease: false,
		htmlUrl: buildReleaseHtmlUrl(RELEASE_TAG),
		vsixAssetName: VSIX_NAME,
		checksumAssetName: SIDECAR_NAME,
		checksumUrl: buildAssetUrl(RELEASE_TAG, SIDECAR_NAME),
		...overrides,
	}
}

function releasePayload(
	tag: string,
	options: { draft?: boolean; prerelease?: boolean; assets?: boolean } = {},
): Record<string, unknown> {
	const version = tag.replace(/^v/, "").split("-")[0]
	return {
		tag_name: tag,
		draft: options.draft ?? false,
		prerelease: options.prerelease ?? false,
		html_url: `https://github.com/ec-jt/Roo-Code/releases/tag/${tag}`,
		published_at: "2026-10-01T00:00:00Z",
		assets:
			options.assets === false
				? []
				: [
						{
							name: `roo-cline-${version}.vsix`,
							size: 4096,
							browser_download_url: `https://evil.example.com/roo-cline-${version}.vsix`,
						},
						{
							name: `roo-cline-${version}.vsix.sha256`,
							size: 96,
							browser_download_url: `https://evil.example.com/roo-cline-${version}.vsix.sha256`,
						},
					],
	}
}

function jsonResponse(data: unknown, status = 200) {
	return { status, headers: { "content-type": "application/json" }, data }
}

function streamResponse(data: Buffer, headers: Record<string, string> = {}, status = 200) {
	return { status, headers: { "content-length": String(data.length), ...headers }, data: Readable.from([data]) }
}

function redirectResponse(location: string, status = 302) {
	return { status, headers: { location }, data: Readable.from([]) }
}

function queueResponses(...responses: unknown[]): void {
	const queue = [...responses]
	requestMock.mockImplementation(async () => {
		const next = queue.shift()
		if (next === undefined) {
			throw new Error("test received an unexpected HTTP request")
		}
		return next as never
	})
}

function requestedConfigs(): Record<string, unknown>[] {
	return requestMock.mock.calls.map((call) => call[0] as unknown as Record<string, unknown>)
}

function syncThrow(fn: () => unknown): unknown {
	try {
		fn()
	} catch (error) {
		return error
	}
	throw new Error("expected the call to throw")
}

async function tempUpdateDirectories(): Promise<string[]> {
	const entries = await fs.readdir(os.tmpdir())
	return entries.filter((entry) => entry.startsWith("roo-update-")).sort()
}

async function fixturePath(fileName: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roo-updatetest-"))
	return path.join(directory, fileName)
}

const createdFixtureDirectories = new Set<string>()

async function writeFixtureTracked(fileName: string, contents: Buffer): Promise<string> {
	const filePath = await fixturePath(fileName)
	createdFixtureDirectories.add(path.dirname(filePath))
	await fs.writeFile(filePath, contents)
	return filePath
}

beforeEach(() => {
	requestMock.mockReset()
})

afterEach(async () => {
	for (const directory of createdFixtureDirectories) {
		await fs.rm(directory, { recursive: true, force: true })
	}
	createdFixtureDirectories.clear()
	for (const entry of await tempUpdateDirectories()) {
		await fs.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true })
	}
})

// ---------------------------------------------------------------------------
// Fixed repository contract
// ---------------------------------------------------------------------------

describe("fixed repository contract", () => {
	it("pins the repository, endpoints, and limits", () => {
		expect(RELEASES_API_URL).toBe("https://api.github.com/repos/ec-jt/Roo-Code/releases")
		expect(RELEASES_MAX_PAGES).toBe(3)
		expect(RELEASES_PER_PAGE).toBe(100)
		expect(MAX_VSIX_BYTES).toBe(128 * 1024 * 1024)
		expect(MAX_SHA256_SIDECAR_BYTES).toBe(4 * 1024)
		expect(MAX_RELEASES_JSON_BYTES).toBe(8 * 1024 * 1024)
		expect([...API_ALLOWED_HOSTS]).toEqual(["api.github.com"])
		expect([...DOWNLOAD_ALLOWED_HOSTS]).toEqual(["github.com", "release-assets.githubusercontent.com"])
		expect(buildAssetUrl("v4.2.30", "roo-cline-4.2.30.vsix")).toBe(
			"https://github.com/ec-jt/Roo-Code/releases/download/v4.2.30/roo-cline-4.2.30.vsix",
		)
		expect(buildReleaseHtmlUrl("v4.2.30-cordis-preview.27")).toBe(
			"https://github.com/ec-jt/Roo-Code/releases/tag/v4.2.30-cordis-preview.27",
		)
	})
})

// ---------------------------------------------------------------------------
// Version, tag, and checksum helpers
// ---------------------------------------------------------------------------

describe("version and tag parsing", () => {
	it.each([
		["v4.2.30", "4.2.30", false, undefined],
		["v4.2.30-cordis-preview.26", "4.2.30", true, 26],
		["v0.0.1", "0.0.1", false, undefined],
		["v10.20.300", "10.20.300", false, undefined],
	])("accepts %s", (tag, version, prerelease, previewNumber) => {
		expect(parseReleaseTag(tag)).toEqual({ version, prerelease, previewNumber })
	})

	it.each([
		"4.2.30",
		"v4.2",
		"v4.2.30.1",
		"v04.2.30",
		"v4.02.30",
		"v4.2.30-cordis-preview",
		"v4.2.30-cordis-preview.0 2",
		"v4.2.30-cordis-preview.026",
		"v4.2.30-beta.1",
		"v4.2.30-rc1",
		"latest",
		"vv4.2.30",
		"main",
	])("rejects %s", (tag) => {
		expect(parseReleaseTag(tag)).toBeUndefined()
	})

	it("accepts only strict numeric x.y.z versions", () => {
		expect(isStrictVersion("4.2.30")).toBe(true)
		expect(isStrictVersion("0.0.0")).toBe(true)
		expect(isStrictVersion("4.2")).toBe(false)
		expect(isStrictVersion("4.2.30-cordis-preview.26")).toBe(false)
		expect(isStrictVersion("v4.2.30")).toBe(false)
		expect(isStrictVersion("04.2.30")).toBe(false)
		expect(isStrictVersion(undefined)).toBe(false)
	})

	it("compares strict versions numerically", () => {
		expect(compareStrictVersions("4.2.30", "4.2.29")).toBe(1)
		expect(compareStrictVersions("4.2.29", "4.10.0")).toBe(-1)
		expect(compareStrictVersions("4.2.30", "4.2.30")).toBe(0)
		expect((syncThrow(() => compareStrictVersions("4.2", "4.2.30")) as UpdateVerificationError).code).toBe(
			"INVALID_CURRENT_VERSION",
		)
	})

	it("parses sha256 sidecars and requires the expected file name", () => {
		const digest = "dcdccf7042c4b75e72313f4f84e355e636344ca4e597c67086bc63adbef3ede2"
		expect(parseSha256Sidecar(`${digest}  ${VSIX_NAME}\n`, VSIX_NAME)).toBe(digest)
		expect(parseSha256Sidecar(`${digest} *${VSIX_NAME}`, VSIX_NAME)).toBe(digest)
		expect(parseSha256Sidecar(digest.toUpperCase(), VSIX_NAME)).toBe(digest)
		expect(parseSha256Sidecar(`${digest}\n\n`, VSIX_NAME)).toBe(digest)
	})
})

describe("checksum sidecar validation", () => {
	const digest = "a".repeat(64)

	it.each([
		[`${digest}  roo-cline-4.2.29.vsix`, "INVALID_CHECKSUM_SIDECAR"],
		[`${"a".repeat(63)}  ${VSIX_NAME}`, "INVALID_CHECKSUM_SIDECAR"],
		[`${digest}\n${digest}  ${VSIX_NAME}`, "INVALID_CHECKSUM_SIDECAR"],
		["", "INVALID_CHECKSUM_SIDECAR"],
		[`sha256:${digest}  ${VSIX_NAME}`, "INVALID_CHECKSUM_SIDECAR"],
		["not-a-checksum", "INVALID_CHECKSUM_SIDECAR"],
	])("rejects %j", (text, code) => {
		const error = syncThrow(() => parseSha256Sidecar(text, VSIX_NAME)) as UpdateVerificationError
		expect(error).toBeInstanceOf(UpdateVerificationError)
		expect(error.code).toBe(code)
	})
})

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

describe("URL policy", () => {
	it("accepts only HTTPS URLs on the allowlisted hosts without credentials", () => {
		expect(assertAllowedUrl("https://api.github.com/repos/ec-jt/Roo-Code/releases", API_ALLOWED_HOSTS, "api")).toBe(
			"https://api.github.com/repos/ec-jt/Roo-Code/releases",
		)
		expect(
			assertAllowedUrl("https://release-assets.githubusercontent.com/x", DOWNLOAD_ALLOWED_HOSTS, "asset"),
		).toBe("https://release-assets.githubusercontent.com/x")
	})

	it.each([
		["http://github.com/ec-jt/Roo-Code", "DOWNLOAD"],
		["https://user:secret@github.com/ec-jt/Roo-Code", "DOWNLOAD"],
		["https://github.com.evil.example/ec-jt/Roo-Code", "DOWNLOAD"],
		["https://api.github.com.evil.example/repos", "API"],
		["https://github.com:8443/ec-jt/Roo-Code", "DOWNLOAD"],
		["file:///etc/passwd", "DOWNLOAD"],
		["//github.com/ec-jt/Roo-Code", "DOWNLOAD"],
		["not-a-url", "DOWNLOAD"],
	])("rejects %s", (url, scope) => {
		const hosts = scope === "API" ? API_ALLOWED_HOSTS : DOWNLOAD_ALLOWED_HOSTS
		const error = syncThrow(() => assertAllowedUrl(url, hosts, "source")) as UpdateVerificationError
		expect(error.code).toBe("INVALID_SOURCE_URL")
	})

	it("allows redirects only to the allowlisted download hosts over HTTPS", () => {
		const current = buildAssetUrl(RELEASE_TAG, VSIX_NAME)
		expect(resolveRedirectLocation(current, "https://release-assets.githubusercontent.com/asset?sig=1")).toBe(
			"https://release-assets.githubusercontent.com/asset?sig=1",
		)
		expect(resolveRedirectLocation(current, "/ec-jt/Roo-Code/releases/download/v4.2.30/x")).toBe(
			"https://github.com/ec-jt/Roo-Code/releases/download/v4.2.30/x",
		)
	})

	it.each([
		"https://evil.example.com/roo-cline-4.2.30.vsix",
		"http://github.com/ec-jt/Roo-Code/releases/download/v4.2.30/x",
		"//evil.example.com/asset",
		"https://user:pass@github.com/asset",
		"",
	])("rejects the redirect target %s", (location) => {
		const error = syncThrow(() =>
			resolveRedirectLocation(buildAssetUrl(RELEASE_TAG, VSIX_NAME), location),
		) as UpdateVerificationError
		expect(error.code).toBe("UNSAFE_REDIRECT")
	})
})

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

describe("candidate selection", () => {
	it("picks the newest release with both required assets", () => {
		const candidate = selectNewestCandidate(
			[releasePayload("v4.2.32", { assets: false }), releasePayload("v4.2.31"), releasePayload("v4.2.30")],
			"4.2.29",
		)
		expect(candidate).toEqual({
			version: "4.2.31",
			tag: "v4.2.31",
			url: "https://github.com/ec-jt/Roo-Code/releases/download/v4.2.31/roo-cline-4.2.31.vsix",
			prerelease: false,
			htmlUrl: "https://github.com/ec-jt/Roo-Code/releases/tag/v4.2.31",
			vsixAssetName: "roo-cline-4.2.31.vsix",
			checksumAssetName: "roo-cline-4.2.31.vsix.sha256",
			checksumUrl: "https://github.com/ec-jt/Roo-Code/releases/download/v4.2.31/roo-cline-4.2.31.vsix.sha256",
			assetSizeBytes: 4096,
			publishedAt: "2026-10-01T00:00:00Z",
		})
	})

	it("prefers the stable release when a Cordis preview shares the same version", () => {
		const candidate = selectNewestCandidate(
			[releasePayload("v4.2.30-cordis-preview.27", { prerelease: true }), releasePayload("v4.2.30")],
			"4.2.29",
		)
		expect(candidate?.tag).toBe("v4.2.30")
		expect(candidate?.prerelease).toBe(false)
	})

	it("picks the highest Cordis preview when only previews are newer", () => {
		const candidate = selectNewestCandidate(
			[
				releasePayload("v4.2.30-cordis-preview.26", { prerelease: true }),
				releasePayload("v4.2.30-cordis-preview.27", { prerelease: true }),
			],
			"4.2.29",
		)
		expect(candidate?.tag).toBe("v4.2.30-cordis-preview.27")
		expect(candidate?.prerelease).toBe(true)
		expect(candidate?.version).toBe("4.2.30")
	})

	it("skips drafts, same-version previews, older versions, and releases without assets", () => {
		expect(selectNewestCandidate([releasePayload("v4.2.30", { draft: true })], "4.2.29")).toBeUndefined()
		expect(
			selectNewestCandidate([releasePayload("v4.2.29-cordis-preview.27", { prerelease: true })], "4.2.29"),
		).toBeUndefined()
		expect(selectNewestCandidate([releasePayload("v4.2.29")], "4.2.29")).toBeUndefined()
		expect(selectNewestCandidate([releasePayload("v4.2.30", { assets: false })], "4.2.29")).toBeUndefined()
	})

	it("rebuilds the asset URL and ignores browser_download_url", () => {
		const candidate = selectNewestCandidate([releasePayload("v4.2.30")], "4.2.29")
		expect(candidate?.url).toContain("https://github.com/ec-jt/Roo-Code/releases/download/v4.2.30/")
		expect(candidate?.url).not.toContain("evil.example.com")
		expect(candidate?.checksumUrl).not.toContain("evil.example.com")
	})

	it("requires a strict current version", () => {
		expect((syncThrow(() => selectNewestCandidate([], "4.2")) as UpdateVerificationError).code).toBe(
			"INVALID_CURRENT_VERSION",
		)
	})
})

// ---------------------------------------------------------------------------
// Engine ranges
// ---------------------------------------------------------------------------

describe("engine range checks", () => {
	it.each([
		["^1.84.0", "1.100.0", "compatible"],
		["^1.84.0", "2.0.0", "incompatible"],
		["^1.84.0", "1.83.0", "incompatible"],
		["^0.2.3", "0.3.0", "incompatible"],
		["~1.84.0", "1.84.9", "compatible"],
		["~1.84.0", "1.85.0", "incompatible"],
		[">=1.84.0 <2.0.0", "1.90.0", "compatible"],
		[">=1.84.0 <2.0.0", "2.1.0", "incompatible"],
		["1.84.0", "1.84.0", "compatible"],
		["1.84", "1.84.5", "compatible"],
		["1.x", "1.99.0", "compatible"],
		["not-a-range", "1.84.0", "unknown"],
		[">=1.84", "1.85.0", "unknown"],
		["^1.84.0", "not-a-version", "unknown"],
		[undefined, "1.84.0", "unknown"],
		["^1.84.0", undefined, "unknown"],
	])("checks %s against %s", (range, actual, expected) => {
		expect(checkEngineRange(range, actual)).toBe(expected)
	})

	it("does not enforce an exact pin unless asked", () => {
		expect(checkEngineRange("20.19.2", "20.20.2")).toBe("incompatible")
		expect(checkEngineRange("20.19.2", "20.20.2", { ignoreExactPin: true })).toBe("unknown")
	})

	it("treats a missing VS Code version as unknown", () => {
		expect(getInstalledVscodeVersion()).toBeUndefined()
		expect(checkEngineRange("^1.84.0", getInstalledVscodeVersion())).toBe("unknown")
	})
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("findReleaseUpdate", () => {
	it("returns the newest candidate and only talks to the fixed API endpoint without credentials", async () => {
		queueResponses(
			jsonResponse([
				releasePayload("v4.2.30-cordis-preview.26", { prerelease: true }),
				releasePayload("v4.2.30"),
			]),
		)

		const candidate = await findReleaseUpdate("4.2.29")

		expect(candidate?.version).toBe("4.2.30")
		expect(candidate?.tag).toBe("v4.2.30")
		const configs = requestedConfigs()
		expect(configs).toHaveLength(1)
		expect(configs[0].url).toBe(`${RELEASES_API_URL}?per_page=100&page=1`)
		expect(configs[0].maxRedirects).toBe(0)
		expect(configs[0].proxy).toBe(false)
		expect(configs[0].decompress).toBe(false)
		const headers = configs[0].headers as Record<string, string>
		expect(headers.Accept).toBe("application/vnd.github+json")
		expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28")
		expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain("authorization")
	})

	it("returns undefined when nothing newer is published", async () => {
		queueResponses(jsonResponse([releasePayload("v4.2.29"), releasePayload("v4.2.28")]))
		expect(await findReleaseUpdate("4.2.29")).toBeUndefined()
	})

	it("reports a missing repository instead of claiming no update exists", async () => {
		queueResponses(jsonResponse({ message: "Not Found" }, 404))
		await expect(findReleaseUpdate("4.2.29")).rejects.toMatchObject({ code: "HTTP_STATUS" })
	})

	it("selects the highest version across bounded pages, not just the first available release", async () => {
		const page = Array.from({ length: RELEASES_PER_PAGE }, () => releasePayload("v4.2.30"))
		queueResponses(jsonResponse(page), jsonResponse([releasePayload("v4.2.35-cordis-preview.30")]))
		expect((await findReleaseUpdate("4.2.29"))?.version).toBe("4.2.35")
		expect(requestedConfigs()).toHaveLength(2)
	})

	it("stops after three pages", async () => {
		const page = Array.from({ length: RELEASES_PER_PAGE }, () => releasePayload("v4.2.29"))
		queueResponses(jsonResponse(page), jsonResponse(page), jsonResponse(page), jsonResponse(page))

		expect(await findReleaseUpdate("4.2.29")).toBeUndefined()
		expect(requestedConfigs()).toHaveLength(RELEASES_MAX_PAGES)
	})

	it("rejects a non-strict current version", async () => {
		await expect(findReleaseUpdate("4.2")).rejects.toMatchObject({ code: "INVALID_CURRENT_VERSION" })
		expect(requestMock).not.toHaveBeenCalled()
	})

	it("honours an aborted signal without making a request", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(findReleaseUpdate("4.2.29", controller.signal)).rejects.toMatchObject({ code: "ABORTED" })
		expect(requestMock).not.toHaveBeenCalled()
	})

	it("maps a transport failure to a stable error code", async () => {
		requestMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com"))

		const error = (await findReleaseUpdate("4.2.29").catch((thrown: unknown) => thrown)) as UpdateVerificationError
		expect(error).toBeInstanceOf(UpdateVerificationError)
		expect(error.code).toBe("UNEXPECTED_RESPONSE")
		expect(error.message).toContain("api.github.com")
	})

	it("maps a request cancelled in flight to ABORTED", async () => {
		const controller = new AbortController()
		requestMock.mockImplementation(async () => {
			controller.abort()
			throw new Error("canceled")
		})

		await expect(findReleaseUpdate("4.2.29", controller.signal)).rejects.toMatchObject({ code: "ABORTED" })
	})
})

// ---------------------------------------------------------------------------
// Download and verification
// ---------------------------------------------------------------------------

describe("downloadVerifiedRelease", () => {
	it("downloads, verifies, and returns a private temporary VSIX path with working cleanup", async () => {
		const archive = buildVsixFixture()
		const sidecar = Buffer.from(`${sha256(archive)}  ${VSIX_NAME}\n`, "utf8")
		queueResponses(streamResponse(sidecar), streamResponse(archive))

		const release = candidateFor()
		const { vsixPath, cleanup } = await downloadVerifiedRelease(release)

		const configs = requestedConfigs()
		expect(configs.map((config) => config.url)).toEqual([release.checksumUrl, release.url])
		expect(configs.every((config) => config.responseType === "stream")).toBe(true)
		expect(configs.every((config) => config.maxRedirects === 0 && config.proxy === false)).toBe(true)

		expect(path.basename(vsixPath)).toBe(VSIX_NAME)
		expect(path.dirname(vsixPath).startsWith(path.join(os.tmpdir(), "roo-update-"))).toBe(true)
		if (os.platform() !== "win32") expect((await fs.stat(path.dirname(vsixPath))).mode & 0o077).toBe(0)
		expect((await fs.stat(vsixPath)).isFile()).toBe(true)
		expect(sha256(await fs.readFile(vsixPath))).toBe(sha256(archive))

		await cleanup()
		await expect(fs.access(vsixPath)).rejects.toThrow()
		expect(await tempUpdateDirectories()).toEqual([])

		// cleanup is idempotent
		await expect(cleanup()).resolves.toBeUndefined()
	})

	it("follows an allowlisted cross-host redirect for the asset", async () => {
		const archive = buildVsixFixture()
		const sidecar = Buffer.from(`${sha256(archive)}  ${VSIX_NAME}\n`, "utf8")
		queueResponses(
			streamResponse(sidecar),
			redirectResponse("https://release-assets.githubusercontent.com/assets/roo-cline-4.2.30.vsix?sig=abc"),
			streamResponse(archive),
		)

		const { vsixPath, cleanup } = await downloadVerifiedRelease(candidateFor())
		expect(sha256(await fs.readFile(vsixPath))).toBe(sha256(archive))
		expect(requestedConfigs()[2].url).toContain("release-assets.githubusercontent.com")
		await cleanup()
	})

	it("rejects a checksum mismatch and leaves no temporary directory behind", async () => {
		const archive = buildVsixFixture()
		queueResponses(
			streamResponse(Buffer.from(`${"b".repeat(64)}  ${VSIX_NAME}\n`, "utf8")),
			streamResponse(archive),
		)

		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" })
		expect(await tempUpdateDirectories()).toEqual([])
	})

	it("rejects a GitHub asset digest mismatch", async () => {
		const archive = buildVsixFixture()
		const sidecar = Buffer.from(`${sha256(archive)}  ${VSIX_NAME}\n`, "utf8")
		queueResponses(streamResponse(sidecar), streamResponse(archive))

		await expect(
			downloadVerifiedRelease(candidateFor({ assetDigest: `sha256:${"c".repeat(64)}` })),
		).rejects.toMatchObject({ code: "ASSET_DIGEST_MISMATCH" })
		expect(await tempUpdateDirectories()).toEqual([])
	})

	it("rejects a size that disagrees with the release asset", async () => {
		const archive = buildVsixFixture()
		const sidecar = Buffer.from(`${sha256(archive)}  ${VSIX_NAME}\n`, "utf8")
		queueResponses(streamResponse(sidecar), streamResponse(archive))

		await expect(downloadVerifiedRelease(candidateFor({ assetSizeBytes: 12 }))).rejects.toMatchObject({
			code: "ASSET_SIZE_MISMATCH",
		})
	})

	it("rejects a sidecar that exceeds the 4 KiB limit", async () => {
		queueResponses({
			status: 200,
			headers: {},
			data: Readable.from([Buffer.alloc(MAX_SHA256_SIDECAR_BYTES + 1, 0x61)]),
		})

		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" })
		expect(await tempUpdateDirectories()).toEqual([])
	})

	it("rejects a VSIX whose declared size exceeds the 128 MiB limit", async () => {
		const sidecar = Buffer.from(`${"a".repeat(64)}  ${VSIX_NAME}\n`, "utf8")
		queueResponses(streamResponse(sidecar), {
			status: 200,
			headers: { "content-length": String(MAX_VSIX_BYTES + 1) },
			data: Readable.from([Buffer.from("x")]),
		})

		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" })
		expect(await tempUpdateDirectories()).toEqual([])
	})

	it("rejects a redirect to an unlisted host without a second request", async () => {
		queueResponses(redirectResponse("https://evil.example.com/roo-cline-4.2.30.vsix"))

		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" })
		expect(requestedConfigs()).toHaveLength(1)
	})

	it("rejects an HTTPS downgrade redirect", async () => {
		queueResponses(redirectResponse("http://github.com/ec-jt/Roo-Code/releases/download/v4.2.30/x"))
		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "UNSAFE_REDIRECT" })
	})

	it("rejects redirect loops", async () => {
		queueResponses(
			...Array.from({ length: MAX_REDIRECTS + 2 }, () =>
				redirectResponse(buildAssetUrl(RELEASE_TAG, SIDECAR_NAME)),
			),
		)

		await expect(downloadVerifiedRelease(candidateFor())).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" })
		expect(requestedConfigs()).toHaveLength(MAX_REDIRECTS + 1)
	})

	it("rejects a tampered candidate URL before any request", async () => {
		await expect(
			downloadVerifiedRelease(candidateFor({ url: "https://evil.example.com/roo-cline-4.2.30.vsix" })),
		).rejects.toMatchObject({ code: "INVALID_SOURCE_URL" })
		await expect(downloadVerifiedRelease(candidateFor({ tag: "v4.2.31" }))).rejects.toMatchObject({
			code: "INVALID_SOURCE_URL",
		})
		await expect(downloadVerifiedRelease(candidateFor({ vsixAssetName: "other.vsix" }))).rejects.toMatchObject({
			code: "MISSING_ASSET",
		})
		expect(requestMock).not.toHaveBeenCalled()
	})

	it("rejects an aborted signal before any request", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(downloadVerifiedRelease(candidateFor(), controller.signal)).rejects.toMatchObject({
			code: "ABORTED",
		})
		expect(requestMock).not.toHaveBeenCalled()
	})
})

// ---------------------------------------------------------------------------
// Archive verification
// ---------------------------------------------------------------------------

async function downloadWithArchive(
	archive: Buffer,
	overrides: Partial<ReleaseCandidate> = {},
): Promise<{ vsixPath: string; cleanup: () => Promise<void> }> {
	const sidecar = Buffer.from(`${sha256(archive)}  ${VSIX_NAME}\n`, "utf8")
	queueResponses(streamResponse(sidecar), streamResponse(archive))
	return downloadVerifiedRelease(candidateFor(overrides))
}

describe("archive verification", () => {
	it("rejects unsafe archives end to end", async () => {
		const cases: { label: string; archive: Buffer; code: string }[] = [
			{
				label: "path traversal entry",
				archive: buildVsixFixture({ extraEntries: [{ name: "../escape.js", data: "x" }] }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "absolute path entry",
				archive: buildVsixFixture({ extraEntries: [{ name: "/etc/passwd", data: "x" }] }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "symbolic link entry",
				archive: buildVsixFixture({
					extraEntries: [{ name: "extension/link", data: "target", mode: 0o120777 }],
				}),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "duplicate manifest entry",
				archive: buildVsixFixture({ extraEntries: [{ name: "extension/package.json", data: manifestFor() }] }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "encrypted entry",
				archive: buildVsixFixture({ manifestFlags: 0x0801 }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "unsupported compression method",
				archive: buildVsixFixture({ manifestMethod: 12 }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "compression bomb ratio",
				archive: buildVsixFixture({
					manifestCompressedSizeOverride: 512,
					manifestUncompressedSizeOverride: 2 * 1024 * 1024,
				}),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "ZIP64 sentinel",
				archive: buildVsixFixture({ manifestCompressedSizeOverride: 0xffffffff }),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "truncated archive",
				archive: buildVsixFixture().subarray(0, buildVsixFixture().length - 8),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "appended data after the archive",
				archive: Buffer.concat([buildVsixFixture(), Buffer.from("GARBAGE-APPENDED")]),
				code: "UNSAFE_ARCHIVE",
			},
			{
				label: "manifest version mismatch",
				archive: buildVsixFixture({ version: "9.9.9", signatureVersion: "9.9.9" }),
				code: "MANIFEST_MISMATCH",
			},
			{
				label: "publisher mismatch",
				archive: buildVsixFixture({ publisher: "someone-else" }),
				code: "MANIFEST_MISMATCH",
			},
			{
				label: "package name mismatch",
				archive: buildVsixFixture({ name: "other-extension" }),
				code: "MANIFEST_MISMATCH",
			},
			{
				label: "invalid manifest JSON",
				archive: buildVsixFixture({ manifestText: "{ not json" }),
				code: "MANIFEST_MISMATCH",
			},
			{
				label: "signature manifest mismatch",
				archive: buildVsixFixture({ signatureVersion: "9.9.9" }),
				code: "MANIFEST_MISMATCH",
			},
		]

		for (const testCase of cases) {
			const error = await downloadWithArchive(testCase.archive).catch((thrown: unknown) => thrown)
			expect(error, testCase.label).toBeInstanceOf(UpdateVerificationError)
			expect((error as UpdateVerificationError).code, testCase.label).toBe(testCase.code)
			expect(await tempUpdateDirectories(), testCase.label).toEqual([])
		}
	})

	it("accepts stored (uncompressed) manifest entries", async () => {
		const archive = buildVsixFixture({ manifestMethod: 0 })
		const { vsixPath, cleanup } = await downloadWithArchive(archive)
		expect(sha256(await fs.readFile(vsixPath))).toBe(sha256(archive))
		await cleanup()
	})

	it("accepts manifest entries written without the data descriptor flag", async () => {
		const archive = buildVsixFixture({ manifestFlags: 0x0800 })
		const { vsixPath, cleanup } = await downloadWithArchive(archive)
		expect(path.basename(vsixPath)).toBe(VSIX_NAME)
		await cleanup()
	})

	it("lists entries from a synthetic archive that mirrors the real VSIX layout", async () => {
		const archive = buildVsixFixture()
		const filePath = await writeFixtureTracked("layout.vsix", archive)

		const entries = await listZipEntries(filePath)
		expect(entries.map((entry) => entry.name)).toEqual([
			"extension.vsixmanifest",
			"extension/package.json",
			"extension/dist/extension.js",
		])
		expect(entries[1].flags & 0x0008).toBe(0x0008)
		expect(DEFAULT_ZIP_LIMITS.maxEntries).toBeGreaterThan(entries.length)
	})

	it("validates the manifest identity directly", async () => {
		const filePath = await writeFixtureTracked("identity.vsix", buildVsixFixture({ publisher: "rooveterinaryinc" }))
		const identity = await inspectVsixManifest(filePath, {
			packageName: "roo-cline",
			publisher: "rooveterinaryinc",
			version: VERSION,
		})
		expect(identity).toEqual({
			packageName: "roo-cline",
			publisher: "rooveterinaryinc",
			version: VERSION,
			enginesVscode: "^1.84.0",
			enginesNode: "20.19.2",
		})
	})

	it("rejects an archive without the manifest", async () => {
		const filePath = await writeFixtureTracked(
			"no-manifest.vsix",
			buildZip([{ name: "extension/dist/extension.js", data: "x" }]),
		)
		await expect(
			inspectVsixManifest(filePath, {
				packageName: "roo-cline",
				publisher: "rooveterinaryinc",
				version: VERSION,
			}),
		).rejects.toMatchObject({ code: "MANIFEST_MISMATCH" })
	})
})

// ---------------------------------------------------------------------------
// Temporary directory safety
// ---------------------------------------------------------------------------

describe("temporary directory safety", () => {
	describe("platform permissions", () => {
		const directory = path.join(os.tmpdir(), "roo-update-mocked")
		beforeEach(() => {
			vi.spyOn(fs, "mkdtemp").mockResolvedValue(directory)
			vi.spyOn(fs, "chmod").mockResolvedValue(undefined)
			vi.spyOn(fs, "rm").mockResolvedValue(undefined)
		})
		afterEach(() => vi.restoreAllMocks())

		it("does not interpret Windows synthetic Unix mode bits as ACL permissions", async () => {
			const stats = await fs.lstat(os.tmpdir())
			vi.spyOn(os, "platform").mockReturnValue("win32")
			vi.spyOn(fs, "lstat").mockResolvedValue(Object.assign(stats, { mode: 0o40777 }))
			await expect(createPrivateTempDirectory()).resolves.toBe(directory)
			expect(fs.chmod).not.toHaveBeenCalled()
			expect(fs.rm).not.toHaveBeenCalled()
		})

		it.each(["linux", "darwin"] as const)("enforces owner-only permissions on %s", async (platform) => {
			const stats = await fs.lstat(os.tmpdir())
			vi.spyOn(os, "platform").mockReturnValue(platform)
			vi.spyOn(fs, "lstat").mockResolvedValue(Object.assign(stats, { mode: 0o40700, uid: process.getuid?.() }))
			await expect(createPrivateTempDirectory()).resolves.toBe(directory)
			expect(fs.chmod).toHaveBeenCalledWith(directory, 0o700)
		})

		it.each(["permissions", "owner", "symlink"])("rejects unsafe POSIX %s and cleans up", async (problem) => {
			const stats = await fs.lstat(os.tmpdir())
			vi.spyOn(os, "platform").mockReturnValue("linux")
			vi.spyOn(fs, "lstat").mockResolvedValue(
				Object.assign(stats, {
					mode: problem === "permissions" ? 0o40755 : 0o40700,
					uid: problem === "owner" ? (process.getuid?.() ?? 0) + 1 : process.getuid?.(),
					isSymbolicLink: () => problem === "symlink",
				}),
			)
			await expect(createPrivateTempDirectory()).rejects.toMatchObject({ code: "TEMPORARY_DIRECTORY" })
			expect(fs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true })
		})

		it("cleans up if setting POSIX permissions fails", async () => {
			vi.spyOn(os, "platform").mockReturnValue("linux")
			vi.mocked(fs.chmod).mockRejectedValue(new Error("Permission denied"))
			await expect(createPrivateTempDirectory()).rejects.toThrow("Permission denied")
			expect(fs.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true })
		})
	})

	it("refuses to remove a directory this module did not create", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roo-foreign-"))
		createdFixtureDirectories.add(directory)

		await expect(removeTempDirectory(directory)).rejects.toMatchObject({ code: "TEMPORARY_DIRECTORY" })
		await expect(fs.access(directory)).resolves.toBeUndefined()
	})

	it("refuses prefixed paths outside the system temporary directory", async () => {
		const outsideTemp = path.join(path.dirname(path.resolve(os.tmpdir())), "roo-update-outside")
		await expect(removeTempDirectory(outsideTemp)).rejects.toMatchObject({ code: "TEMPORARY_DIRECTORY" })
		await expect(removeTempDirectory("../roo-update-traversal")).rejects.toMatchObject({
			code: "TEMPORARY_DIRECTORY",
		})
		await expect(removeTempDirectory(path.join(os.tmpdir(), "roo-update-"))).rejects.toMatchObject({
			code: "TEMPORARY_DIRECTORY",
		})
	})
})
