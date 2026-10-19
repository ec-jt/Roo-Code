import * as crypto from "crypto"
import * as fsSync from "fs"
import * as fs from "fs/promises"
import * as https from "https"
import * as os from "os"
import * as path from "path"
import axios from "axios"
import type { AxiosRequestConfig } from "axios"
import * as vscode from "vscode"

import { UpdateVerificationError, updateError } from "./errors"
import { inspectVsixManifest } from "./zipInspect"

export { UpdateVerificationError } from "./errors"
export type { UpdateErrorCode } from "./errors"

/**
 * GitHub release discovery, download, and verification engine for the in-app
 * updater.
 *
 * Scope and guarantees:
 * - The repository is fixed in code. No user, webview, or settings value can
 *   change the origin, the repository, or the asset paths, so this code cannot
 *   be turned into an arbitrary download or request primitive.
 * - Only stable releases (`vX.Y.Z`) and Cordis previews
 *   (`vX.Y.Z-cordis-preview.N`) are considered. Tags must be a strict numeric
 *   `x.y.z` version, must be strictly newer than the running extension version,
 *   must not be a draft, and must carry both `roo-cline-X.Y.Z.vsix` and
 *   `roo-cline-X.Y.Z.vsix.sha256`.
 * - Asset URLs are rebuilt from the fixed repository and the validated tag.
 *   `browser_download_url` from the API is deliberately ignored so a tampered
 *   API payload cannot redirect the download.
 * - Requests are HTTPS only, have no credentials, do not follow redirects off
 *   `github.com` / `release-assets.githubusercontent.com`, keep TLS validation
 *   on, honour an `AbortSignal`, and enforce time and size limits.
 * - The VSIX is written to a private `mkdtemp` directory, its SHA-256 is checked
 *   against the sidecar (and the GitHub asset digest when present), and its
 *   manifest identity is validated before the path is handed out. Nothing is
 *   installed, executed, or extracted.
 */

export const UPDATE_REPO_OWNER = "ec-jt"
export const UPDATE_REPO_NAME = "Roo-Code"
export const RELEASES_API_ORIGIN = "https://api.github.com"
export const RELEASES_API_URL = `${RELEASES_API_ORIGIN}/repos/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases`

/** Bounded pagination: at most 3 pages of 100 releases, newest first. */
export const RELEASES_MAX_PAGES = 3
export const RELEASES_PER_PAGE = 100

export const MAX_VSIX_BYTES = 128 * 1024 * 1024
export const MAX_SHA256_SIDECAR_BYTES = 4 * 1024
export const MAX_RELEASES_JSON_BYTES = 8 * 1024 * 1024
export const MAX_REDIRECTS = 5

export const VSIX_PACKAGE_NAME = "roo-cline"
export const VSIX_PUBLISHER = "rooveterinaryinc"

export const API_ALLOWED_HOSTS = ["api.github.com"] as const
export const DOWNLOAD_ALLOWED_HOSTS = ["github.com", "release-assets.githubusercontent.com"] as const
export const RELEASE_PAGE_ALLOWED_HOSTS = ["github.com"] as const

const UPDATER_USER_AGENT = "roo-code-updater"
const REQUEST_TIMEOUT_MS = 30_000
const SIDECAR_DEADLINE_MS = 30_000
const VSIX_DEADLINE_MS = 5 * 60_000
const TEMP_DIRECTORY_PREFIX = "roo-update-"

const STRICT_VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/
const RELEASE_TAG_PATTERN = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-cordis-preview\.(\d{1,6}))?$/

export interface ReleaseCandidate {
	version: string
	tag: string
	/** Canonical HTTPS download URL of `roo-cline-<version>.vsix`, rebuilt from the fixed repository. */
	url: string
	prerelease: boolean
	htmlUrl: string
	vsixAssetName: string
	checksumAssetName: string
	checksumUrl: string
	/** `sha256:<hex>` when the GitHub release asset exposes a digest. */
	assetDigest?: string
	assetSizeBytes?: number
	publishedAt?: string
}

export interface ReleaseDownload {
	vsixPath: string
	cleanup: () => Promise<void>
}

export interface RawGitHubRelease {
	tag_name?: unknown
	draft?: unknown
	prerelease?: unknown
	html_url?: unknown
	published_at?: unknown
	assets?: unknown
}

interface ReleaseAssetSummary {
	name: string
	size?: number
	digest?: string
}

// ---------------------------------------------------------------------------
// Version and tag handling
// ---------------------------------------------------------------------------

export function isStrictVersion(value: unknown): value is string {
	if (typeof value !== "string") {
		return false
	}
	const match = STRICT_VERSION_PATTERN.exec(value)
	if (!match) {
		return false
	}
	return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` === value
}

export interface ParsedReleaseTag {
	version: string
	prerelease: boolean
	previewNumber?: number
}

/**
 * Parses `vX.Y.Z` and `vX.Y.Z-cordis-preview.N` tags. Leading zeros, extra
 * suffixes (for example `-beta.1`), and non-numeric versions are rejected.
 */
export function parseReleaseTag(tag: string): ParsedReleaseTag | undefined {
	if (typeof tag !== "string") {
		return undefined
	}
	const trimmed = tag.trim()
	const match = RELEASE_TAG_PATTERN.exec(trimmed)
	if (!match) {
		return undefined
	}
	const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
	if (version !== trimmed.slice(1).split("-")[0]) {
		return undefined
	}
	const preview = match[4]
	if (preview === undefined) {
		return { version, prerelease: false }
	}
	if (String(Number(preview)) !== preview) {
		return undefined
	}
	return { version, prerelease: true, previewNumber: Number(preview) }
}

interface VersionParts {
	major: number
	minor: number
	patch: number
}

function parseStrictVersionParts(value: string): VersionParts | undefined {
	const match = STRICT_VERSION_PATTERN.exec(value)
	if (!match) {
		return undefined
	}
	const parts = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
	if (`${parts.major}.${parts.minor}.${parts.patch}` !== value) {
		return undefined
	}
	return parts
}

/** Compares two strict `x.y.z` versions. Throws when either input is not strict. */
export function compareStrictVersions(left: string, right: string): number {
	const a = parseStrictVersionParts(left)
	const b = parseStrictVersionParts(right)
	if (!a || !b) {
		throw updateError(
			"INVALID_CURRENT_VERSION",
			`Cannot compare "${String(left)}" with "${String(right)}"; both must be strict x.y.z versions.`,
		)
	}
	if (a.major !== b.major) {
		return a.major < b.major ? -1 : 1
	}
	if (a.minor !== b.minor) {
		return a.minor < b.minor ? -1 : 1
	}
	if (a.patch !== b.patch) {
		return a.patch < b.patch ? -1 : 1
	}
	return 0
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/** Validates an absolute HTTPS URL against a fixed host allowlist. */
export function assertAllowedUrl(rawUrl: string, allowedHosts: readonly string[], label: string): string {
	let url: URL
	try {
		url = new URL(rawUrl)
	} catch {
		throw updateError("INVALID_SOURCE_URL", `${label} is not an absolute URL.`)
	}
	if (url.protocol !== "https:") {
		throw updateError("INVALID_SOURCE_URL", `${label} must use HTTPS.`)
	}
	if (url.username !== "" || url.password !== "") {
		throw updateError("INVALID_SOURCE_URL", `${label} must not contain credentials.`)
	}
	if (url.port !== "" && url.port !== "443") {
		throw updateError("INVALID_SOURCE_URL", `${label} must not use a non-default port.`)
	}
	const host = url.hostname.toLowerCase()
	if (!allowedHosts.includes(host)) {
		throw updateError("INVALID_SOURCE_URL", `${label} host "${host}" is not allowed.`)
	}
	return url.href
}

/** Resolves a redirect target and enforces the download host allowlist. */
export function resolveRedirectLocation(
	currentUrl: string,
	location: string,
	allowedHosts: readonly string[] = DOWNLOAD_ALLOWED_HOSTS,
): string {
	if (typeof location !== "string" || location.trim().length === 0) {
		throw updateError("UNSAFE_REDIRECT", "Redirect response did not include a Location header.")
	}
	let resolved: URL
	try {
		resolved = new URL(location, currentUrl)
	} catch {
		throw updateError("UNSAFE_REDIRECT", "Redirect target is not a valid absolute URL.")
	}
	try {
		return assertAllowedUrl(resolved.href, allowedHosts, "Redirect target")
	} catch (error) {
		if (error instanceof UpdateVerificationError) {
			throw updateError("UNSAFE_REDIRECT", error.message)
		}
		throw error
	}
}

export function buildAssetUrl(tag: string, assetName: string): string {
	return `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
}

export function buildReleaseHtmlUrl(tag: string): string {
	return `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO_NAME}/releases/tag/${encodeURIComponent(tag)}`
}

// ---------------------------------------------------------------------------
// Release payload handling
// ---------------------------------------------------------------------------

export function parseReleaseList(payload: unknown): RawGitHubRelease[] {
	if (!Array.isArray(payload)) {
		throw updateError("UNEXPECTED_RESPONSE", "GitHub releases response was not a list of releases.")
	}
	return payload.filter(
		(item): item is RawGitHubRelease => Boolean(item) && typeof item === "object" && !Array.isArray(item),
	)
}

function normalizeAssetDigest(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined
	}
	const match = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(value.trim())
	return match ? `sha256:${match[1].toLowerCase()}` : undefined
}

function findAsset(assets: unknown, name: string): ReleaseAssetSummary | undefined {
	if (!Array.isArray(assets)) {
		return undefined
	}
	for (const asset of assets) {
		if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
			continue
		}
		const record = asset as Record<string, unknown>
		if (record.name !== name) {
			continue
		}
		const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined
		return { name, size, digest: normalizeAssetDigest(record.digest) }
	}
	return undefined
}

function isBetterCandidate(
	candidate: ReleaseCandidate,
	candidatePreview: number,
	best: ReleaseCandidate | undefined,
	bestPreview: number,
): boolean {
	if (!best) {
		return true
	}
	const order = compareStrictVersions(candidate.version, best.version)
	if (order !== 0) {
		return order > 0
	}
	// Same numeric version: a stable release is preferred over a Cordis preview,
	// and a higher preview number is preferred over a lower one.
	if (candidate.prerelease !== best.prerelease) {
		return !candidate.prerelease
	}
	if (!candidate.prerelease) {
		return false
	}
	return candidatePreview > bestPreview
}

/**
 * Pure selection helper. Given raw GitHub release payloads and the running
 * version, returns the newest usable candidate, or `undefined`.
 */
export function selectNewestCandidate(releases: unknown, currentVersion: string): ReleaseCandidate | undefined {
	if (!isStrictVersion(currentVersion)) {
		throw updateError(
			"INVALID_CURRENT_VERSION",
			`Current version "${String(currentVersion)}" is not a strict x.y.z version.`,
		)
	}
	if (!Array.isArray(releases)) {
		return undefined
	}

	let best: ReleaseCandidate | undefined
	let bestPreview = -1

	for (const item of releases) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			continue
		}
		const record = item as Record<string, unknown>
		if (record.draft === true) {
			continue
		}
		if (typeof record.tag_name !== "string") {
			continue
		}
		const tag = record.tag_name
		const parsed = parseReleaseTag(tag)
		if (!parsed) {
			continue
		}
		if (compareStrictVersions(parsed.version, currentVersion) <= 0) {
			continue
		}

		const vsixAssetName = `${VSIX_PACKAGE_NAME}-${parsed.version}.vsix`
		const checksumAssetName = `${vsixAssetName}.sha256`
		const vsixAsset = findAsset(record.assets, vsixAssetName)
		const checksumAsset = findAsset(record.assets, checksumAssetName)
		if (!vsixAsset || !checksumAsset) {
			continue
		}

		const candidate: ReleaseCandidate = {
			version: parsed.version,
			tag,
			url: buildAssetUrl(tag, vsixAssetName),
			prerelease: parsed.prerelease,
			htmlUrl: buildReleaseHtmlUrl(tag),
			vsixAssetName,
			checksumAssetName,
			checksumUrl: buildAssetUrl(tag, checksumAssetName),
		}
		if (vsixAsset.digest) {
			candidate.assetDigest = vsixAsset.digest
		}
		if (vsixAsset.size !== undefined) {
			candidate.assetSizeBytes = vsixAsset.size
		}
		if (typeof record.published_at === "string" && record.published_at.length > 0) {
			candidate.publishedAt = record.published_at
		}

		if (isBetterCandidate(candidate, parsed.previewNumber ?? -1, best, bestPreview)) {
			best = candidate
			bestPreview = parsed.previewNumber ?? -1
		}
	}

	return best
}

// ---------------------------------------------------------------------------
// Checksum sidecar
// ---------------------------------------------------------------------------

/**
 * Parses a `sha256sum` style sidecar and requires it to refer to the expected
 * file name. Returns the lowercase hex digest.
 */
export function parseSha256Sidecar(text: string, expectedFileName: string): string {
	if (typeof text !== "string") {
		throw updateError("INVALID_CHECKSUM_SIDECAR", "Checksum sidecar is not text.")
	}
	const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
	if (lines.length !== 1) {
		throw updateError("INVALID_CHECKSUM_SIDECAR", "Checksum sidecar must contain exactly one line.")
	}
	const match = /^([0-9a-fA-F]{64})(?:[\t ]+\*?(.+?))?[\t ]*$/.exec(lines[0])
	if (!match) {
		throw updateError("INVALID_CHECKSUM_SIDECAR", "Checksum sidecar does not contain a single SHA-256 digest.")
	}
	const fileName = match[2]
	if (fileName !== undefined) {
		const normalized = fileName.replace(/^\.\//, "").trim()
		if (normalized !== expectedFileName) {
			throw updateError(
				"INVALID_CHECKSUM_SIDECAR",
				`Checksum sidecar refers to "${normalized}", not "${expectedFileName}".`,
			)
		}
	}
	return match[1].toLowerCase()
}

function assertDigestEquals(
	actual: string,
	expected: string,
	code: "CHECKSUM_MISMATCH" | "ASSET_DIGEST_MISMATCH",
): void {
	const actualBuffer = Buffer.from(actual.toLowerCase(), "hex")
	const expectedBuffer = Buffer.from(expected.replace(/^sha256:/, "").toLowerCase(), "hex")
	const matches =
		actualBuffer.length === expectedBuffer.length &&
		actualBuffer.length === 32 &&
		crypto.timingSafeEqual(actualBuffer, expectedBuffer)
	if (!matches) {
		throw updateError(code, `Downloaded VSIX digest ${actual} does not match the expected digest.`)
	}
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface HttpResponseLike {
	status: number
	headers: unknown
	data: unknown
}

interface FetchOptions {
	url: string
	allowedHosts: readonly string[]
	responseType: "json" | "stream"
	maxBytes: number
	signal?: AbortSignal
	acceptStatuses?: readonly number[]
}

interface AsyncIterableStream extends AsyncIterable<Buffer | string> {
	destroy?: () => void
}

let cachedHttpsAgent: https.Agent | undefined

function httpsAgent(): https.Agent {
	cachedHttpsAgent ??= new https.Agent({ keepAlive: true, maxSockets: 4, rejectUnauthorized: true })
	return cachedHttpsAgent
}

function throwIfAborted(signal: AbortSignal | undefined, label: string): void {
	if (signal?.aborted) {
		throw updateError("ABORTED", `${label} was cancelled.`)
	}
}

function headerValue(headers: unknown, name: string): string | undefined {
	if (!headers || typeof headers !== "object") {
		return undefined
	}
	const record = headers as Record<string, unknown>
	const direct = record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()]
	if (Array.isArray(direct)) {
		return direct.length > 0 ? String(direct[0]) : undefined
	}
	if (typeof direct === "string" || typeof direct === "number") {
		return String(direct)
	}
	const getter = (headers as { get?: (key: string) => unknown }).get
	if (typeof getter === "function") {
		const value = getter.call(headers, name)
		return value === undefined || value === null ? undefined : String(value)
	}
	return undefined
}

function declaredContentLength(headers: unknown): number | undefined {
	const raw = headerValue(headers, "content-length")
	if (raw === undefined) {
		return undefined
	}
	const parsed = Number(raw)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function destroyStream(value: unknown): void {
	const stream = value as { destroy?: () => void } | undefined
	try {
		stream?.destroy?.()
	} catch {
		// Ignoring a failure to release an unused response stream is safe.
	}
}

async function sendRequest(config: AxiosRequestConfig): Promise<HttpResponseLike> {
	return (await axios.request(config)) as unknown as HttpResponseLike
}

async function fetchFollowingRedirects(options: FetchOptions): Promise<HttpResponseLike> {
	let currentUrl = assertAllowedUrl(options.url, options.allowedHosts, "Request URL")

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		throwIfAborted(options.signal, "Update request")
		let response: HttpResponseLike
		try {
			response = await sendRequest({
				url: currentUrl,
				method: "GET",
				responseType: options.responseType,
				timeout: REQUEST_TIMEOUT_MS,
				maxRedirects: 0,
				maxContentLength: options.maxBytes,
				maxBodyLength: 0,
				// Keep TLS certificate validation on and do not let proxy environment
				// variables widen the fixed host allowlist.
				proxy: false,
				httpsAgent: httpsAgent(),
				// Request raw bytes so Content-Length stays authoritative and no
				// transport level decompression happens.
				decompress: false,
				headers: {
					Accept:
						options.responseType === "json" ? "application/vnd.github+json" : "application/octet-stream",
					"Accept-Encoding": "identity",
					"User-Agent": UPDATER_USER_AGENT,
					...(options.responseType === "json" ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
				},
				validateStatus: () => true,
				signal: options.signal,
			})
		} catch (error) {
			// Transport failures (DNS, TLS, timeout, connection reset) become a stable
			// error code instead of leaking a transport specific error object.
			if (options.signal?.aborted) {
				throw updateError("ABORTED", "Update request was cancelled.")
			}
			throw updateError(
				"UNEXPECTED_RESPONSE",
				`Request for ${currentUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		const status = Number(response.status)
		if (status >= 300 && status < 400) {
			destroyStream(response.data)
			const location = headerValue(response.headers, "location")
			if (!location) {
				throw updateError(
					"UNSAFE_REDIRECT",
					`HTTP ${status} response for ${currentUrl} had no Location header.`,
				)
			}
			currentUrl = resolveRedirectLocation(currentUrl, location, options.allowedHosts)
			continue
		}
		if (status < 200 || status >= 300) {
			destroyStream(response.data)
			if (options.acceptStatuses?.includes(status)) {
				return response
			}
			throw updateError("HTTP_STATUS", `Request for ${currentUrl} failed with HTTP ${status}.`)
		}
		return response
	}

	throw updateError("TOO_MANY_REDIRECTS", `Request for ${options.url} exceeded ${MAX_REDIRECTS} redirects.`)
}

interface ConsumeOptions {
	maxBytes: number
	declaredBytes?: number
	deadlineMs: number
	signal?: AbortSignal
	label: string
	onChunk: (chunk: Buffer) => void | Promise<void>
}

async function consumeStream(source: unknown, options: ConsumeOptions): Promise<{ bytes: number; sha256: string }> {
	const stream = source as AsyncIterableStream
	if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
		throw updateError("UNEXPECTED_RESPONSE", `${options.label} response did not include a readable body.`)
	}
	if (options.declaredBytes !== undefined && options.declaredBytes > options.maxBytes) {
		destroyStream(stream)
		throw updateError(
			"RESPONSE_TOO_LARGE",
			`${options.label} declares ${options.declaredBytes} bytes, above the ${options.maxBytes} byte limit.`,
		)
	}
	throwIfAborted(options.signal, options.label)

	const hash = crypto.createHash("sha256")
	let bytes = 0
	let timedOut = false
	const onAbort = () => destroyStream(stream)
	options.signal?.addEventListener("abort", onAbort)
	const timer = setTimeout(() => {
		timedOut = true
		destroyStream(stream)
	}, options.deadlineMs)
	if (typeof timer.unref === "function") {
		timer.unref()
	}

	try {
		for await (const chunk of stream) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			bytes += buffer.length
			if (bytes > options.maxBytes) {
				destroyStream(stream)
				throw updateError("RESPONSE_TOO_LARGE", `${options.label} exceeded the ${options.maxBytes} byte limit.`)
			}
			hash.update(buffer)
			await options.onChunk(buffer)
		}
	} catch (error) {
		destroyStream(stream)
		if (error instanceof UpdateVerificationError) {
			throw error
		}
		if (options.signal?.aborted) {
			throw updateError("ABORTED", `${options.label} was cancelled.`)
		}
		if (timedOut) {
			throw updateError("ABORTED", `${options.label} timed out.`)
		}
		throw updateError(
			"UNEXPECTED_RESPONSE",
			`${options.label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
		)
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", onAbort)
	}

	if (timedOut) {
		throw updateError("ABORTED", `${options.label} timed out.`)
	}
	if (options.declaredBytes !== undefined && options.declaredBytes !== bytes) {
		throw updateError(
			"INCOMPLETE_RESPONSE",
			`${options.label} returned ${bytes} bytes but declared ${options.declaredBytes}.`,
		)
	}
	return { bytes, sha256: hash.digest("hex") }
}

async function readBoundedResponse(
	response: HttpResponseLike,
	options: Omit<ConsumeOptions, "onChunk">,
): Promise<Buffer> {
	const chunks: Buffer[] = []
	await consumeStream(response.data, {
		...options,
		onChunk: (chunk) => {
			chunks.push(chunk)
		},
	})
	return Buffer.concat(chunks)
}

async function streamResponseToFile(
	response: HttpResponseLike,
	filePath: string,
	options: Omit<ConsumeOptions, "onChunk">,
): Promise<{ bytes: number; sha256: string }> {
	const writeStream = fsSync.createWriteStream(filePath, { flags: "wx", mode: 0o600 })
	let writeError: Error | undefined
	writeStream.on("error", (error: Error) => {
		writeError = error
	})
	try {
		const result = await consumeStream(response.data, {
			...options,
			onChunk: (chunk) =>
				new Promise<void>((resolve, reject) => {
					if (writeError) {
						reject(writeError)
						return
					}
					if (writeStream.write(chunk)) {
						resolve()
						return
					}
					writeStream.once("drain", resolve)
				}),
		})
		if (writeError) {
			throw writeError
		}
		await new Promise<void>((resolve, reject) => {
			writeStream.end(() => (writeError ? reject(writeError) : resolve()))
		})
		return result
	} catch (error) {
		writeStream.destroy()
		await fs.rm(filePath, { force: true })
		throw error
	}
}

// ---------------------------------------------------------------------------
// Temporary directory handling
// ---------------------------------------------------------------------------

export async function createPrivateTempDirectory(): Promise<string> {
	const base = path.resolve(os.tmpdir())
	const directory = await fs.mkdtemp(path.join(base, TEMP_DIRECTORY_PREFIX))
	try {
		// Windows uses inherited ACLs from the user's temporary directory. Node's
		// chmod/stat mode bits do not set or report those ACLs and can show 0777.
		const windows = os.platform() === "win32"
		if (!windows) await fs.chmod(directory, 0o700)
		const stats = await fs.lstat(directory)
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw updateError("TEMPORARY_DIRECTORY", "Temporary update path is not a regular directory.")
		}
		if (!windows && ((stats.mode & 0o077) !== 0 || stats.uid !== process.getuid?.())) {
			throw updateError(
				"TEMPORARY_DIRECTORY",
				"Temporary update directory is not private. Use a temporary filesystem that supports owner-only permissions.",
			)
		}
	} catch (error) {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
		throw error
	}
	return directory
}

/**
 * Removes a directory that this module created, and refuses anything else. The
 * guard requires a direct child of the system temporary directory whose name is
 * `roo-update-` plus the random suffix produced by `mkdtemp`.
 */
export async function removeTempDirectory(directory: string): Promise<void> {
	const resolved = path.resolve(directory)
	const base = path.resolve(os.tmpdir())
	const name = path.basename(resolved)
	const suffix = name.startsWith(TEMP_DIRECTORY_PREFIX) ? name.slice(TEMP_DIRECTORY_PREFIX.length) : ""
	if (!resolved.startsWith(base + path.sep) || suffix.length < 6) {
		throw updateError("TEMPORARY_DIRECTORY", "Refusing to remove a directory that this module did not create.")
	}
	await fs.rm(resolved, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Candidate validation
// ---------------------------------------------------------------------------

interface PreparedCandidate {
	version: string
	tag: string
	vsixAssetName: string
	checksumAssetName: string
	vsixUrl: string
	checksumUrl: string
	assetDigest?: string
	assetSizeBytes?: number
}

function prepareCandidate(release: ReleaseCandidate): PreparedCandidate {
	if (!release || typeof release !== "object") {
		throw updateError("INVALID_SOURCE_URL", "Release candidate is not an object.")
	}
	if (!isStrictVersion(release.version)) {
		throw updateError("INVALID_SOURCE_URL", `Release candidate version "${String(release.version)}" is not strict.`)
	}
	const parsed = typeof release.tag === "string" ? parseReleaseTag(release.tag) : undefined
	if (!parsed || parsed.version !== release.version) {
		throw updateError(
			"INVALID_SOURCE_URL",
			`Release candidate tag "${String(release.tag)}" does not match its version.`,
		)
	}

	const vsixAssetName = `${VSIX_PACKAGE_NAME}-${release.version}.vsix`
	const checksumAssetName = `${vsixAssetName}.sha256`
	if (release.vsixAssetName !== vsixAssetName || release.checksumAssetName !== checksumAssetName) {
		throw updateError(
			"MISSING_ASSET",
			"Release candidate asset names are not the expected VSIX and checksum names.",
		)
	}

	const expectedVsixUrl = buildAssetUrl(release.tag, vsixAssetName)
	const expectedChecksumUrl = buildAssetUrl(release.tag, checksumAssetName)
	if (release.url !== expectedVsixUrl) {
		throw updateError(
			"INVALID_SOURCE_URL",
			"Release candidate download URL is not the expected repository asset URL.",
		)
	}
	if (release.checksumUrl !== expectedChecksumUrl) {
		throw updateError(
			"INVALID_SOURCE_URL",
			"Release candidate checksum URL is not the expected repository asset URL.",
		)
	}
	assertAllowedUrl(release.url, DOWNLOAD_ALLOWED_HOSTS, "Candidate download URL")
	assertAllowedUrl(release.checksumUrl, DOWNLOAD_ALLOWED_HOSTS, "Candidate checksum URL")
	if (release.htmlUrl !== undefined) {
		assertAllowedUrl(release.htmlUrl, RELEASE_PAGE_ALLOWED_HOSTS, "Candidate release page URL")
	}

	return {
		version: release.version,
		tag: release.tag,
		vsixAssetName,
		checksumAssetName,
		vsixUrl: release.url,
		checksumUrl: release.checksumUrl,
		assetDigest: normalizeAssetDigest(release.assetDigest),
		assetSizeBytes:
			typeof release.assetSizeBytes === "number" &&
			Number.isFinite(release.assetSizeBytes) &&
			release.assetSizeBytes >= 0
				? release.assetSizeBytes
				: undefined,
	}
}

// ---------------------------------------------------------------------------
// Engine version compatibility
// ---------------------------------------------------------------------------

export type EngineCheckResult = "compatible" | "incompatible" | "unknown"

interface ComparableVersion {
	major: number
	minor: number
	patch: number
}

function parseComparableVersion(value: string): ComparableVersion | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(value.trim())
	if (!match) {
		return undefined
	}
	return {
		major: Number(match[1]),
		minor: match[2] === undefined ? 0 : Number(match[2]),
		patch: match[3] === undefined ? 0 : Number(match[3]),
	}
}

function parseExactVersion(value: string): ComparableVersion | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
	return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : undefined
}

function compareComparable(left: ComparableVersion, right: ComparableVersion): number {
	if (left.major !== right.major) {
		return left.major < right.major ? -1 : 1
	}
	if (left.minor !== right.minor) {
		return left.minor < right.minor ? -1 : 1
	}
	if (left.patch !== right.patch) {
		return left.patch < right.patch ? -1 : 1
	}
	return 0
}

/** Equality against a partial version such as `1.84`; the missing parts act as a wildcard. */
function comparePartialVersion(value: string, actual: ComparableVersion): boolean | undefined {
	const parts = value.trim().split(".")
	if (parts.length === 0 || parts.length > 3) {
		return undefined
	}
	const actualParts = [actual.major, actual.minor, actual.patch]
	for (let index = 0; index < parts.length; index++) {
		if (!/^\d+$/.test(parts[index])) {
			return undefined
		}
		if (Number(parts[index]) !== actualParts[index]) {
			return false
		}
	}
	return true
}

function evaluateComparator(token: string, actual: ComparableVersion): boolean | undefined {
	const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
	if (!operatorMatch) {
		return undefined
	}
	const operator = operatorMatch[1] ?? ""
	const versionText = operatorMatch[2].trim()

	if (/[xX*]/.test(versionText)) {
		if (operator !== "" && operator !== "=") {
			return undefined
		}
		const parts = versionText.split(".")
		if (parts.length > 3) {
			return undefined
		}
		const actualParts = [actual.major, actual.minor, actual.patch]
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index]
			if (part === "x" || part === "X" || part === "*") {
				return true
			}
			if (!/^\d+$/.test(part) || Number(part) !== actualParts[index]) {
				return false
			}
		}
		return true
	}

	if (operator === "^" || operator === "~") {
		const base = parseExactVersion(versionText)
		if (!base) {
			return undefined
		}
		const upperBound: ComparableVersion =
			operator === "~"
				? { major: base.major, minor: base.minor + 1, patch: 0 }
				: base.major > 0
					? { major: base.major + 1, minor: 0, patch: 0 }
					: base.minor > 0
						? { major: 0, minor: base.minor + 1, patch: 0 }
						: { major: 0, minor: 0, patch: base.patch + 1 }
		return compareComparable(actual, base) >= 0 && compareComparable(actual, upperBound) < 0
	}

	if (operator === "" || operator === "=") {
		const exact = parseExactVersion(versionText)
		return exact ? compareComparable(actual, exact) === 0 : comparePartialVersion(versionText, actual)
	}
	const exact = parseExactVersion(versionText)
	if (!exact) {
		// Partial versions combined with an inequality have ambiguous semantics, so
		// the check is reported as unknown instead of risking a false rejection.
		return undefined
	}
	switch (operator) {
		case ">=":
			return compareComparable(actual, exact) >= 0
		case ">":
			return compareComparable(actual, exact) > 0
		case "<=":
			return compareComparable(actual, exact) <= 0
		case "<":
			return compareComparable(actual, exact) < 0
		default:
			return undefined
	}
}

/**
 * Evaluates the subset of semver ranges that extension engines actually use:
 * exact `x.y.z`, partial and wildcard versions, `^`, `~`, and the inequality
 * operators with full versions, optionally combined with `||`.
 *
 * Prerelease suffixes on the measured version are ignored. Anything outside the
 * supported subset returns `"unknown"` so the caller never rejects an update
 * because the parser was incomplete.
 */
export function checkEngineRange(
	range: string | undefined,
	actualVersion: string | undefined,
	options: { ignoreExactPin?: boolean } = {},
): EngineCheckResult {
	if (typeof range !== "string" || range.trim().length === 0) {
		return "unknown"
	}
	if (typeof actualVersion !== "string" || actualVersion.trim().length === 0) {
		return "unknown"
	}
	const actual = parseComparableVersion(actualVersion)
	if (!actual) {
		return "unknown"
	}

	let sawUnknown = false
	for (const alternative of range.split("||")) {
		const tokens = alternative
			.trim()
			.split(/\s+/)
			.filter((token) => token.length > 0)
		if (tokens.length === 0) {
			sawUnknown = true
			continue
		}
		if (options.ignoreExactPin && tokens.length === 1 && /^v?\d+\.\d+\.\d+$/.test(tokens[0])) {
			// Exact pins such as engines.node "20.19.2" are not enforced.
			sawUnknown = true
			continue
		}
		let satisfied = true
		let unresolved = false
		for (const token of tokens) {
			const result = evaluateComparator(token, actual)
			if (result === undefined) {
				unresolved = true
				break
			}
			if (!result) {
				satisfied = false
				break
			}
		}
		if (unresolved) {
			sawUnknown = true
			continue
		}
		if (satisfied) {
			return "compatible"
		}
	}
	return sawUnknown ? "unknown" : "incompatible"
}

/**
 * Returns the running VS Code version when the extension host is available.
 * Tests, CLI contexts, and any host that cannot report a version return
 * `undefined`, which makes the engine check opt-in rather than a false failure.
 */
export function getInstalledVscodeVersion(): string | undefined {
	try {
		const value = (vscode as { version?: unknown }).version
		return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
	} catch {
		return undefined
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Finds the newest usable release newer than `currentVersion`.
 *
 * Bounded to `RELEASES_MAX_PAGES` requests of `RELEASES_PER_PAGE` releases, with
 * no credentials. Returns `undefined` when no newer release has the required
 * assets.
 */
export async function findReleaseUpdate(
	currentVersion: string,
	signal?: AbortSignal,
): Promise<ReleaseCandidate | undefined> {
	if (!isStrictVersion(currentVersion)) {
		throw updateError(
			"INVALID_CURRENT_VERSION",
			`Current version "${String(currentVersion)}" is not a strict x.y.z version.`,
		)
	}

	const allReleases: RawGitHubRelease[] = []
	for (let page = 1; page <= RELEASES_MAX_PAGES; page++) {
		const url = `${RELEASES_API_URL}?per_page=${RELEASES_PER_PAGE}&page=${page}`
		const response = await fetchFollowingRedirects({
			url,
			allowedHosts: API_ALLOWED_HOSTS,
			responseType: "json",
			maxBytes: MAX_RELEASES_JSON_BYTES,
			signal,
			acceptStatuses: [404],
		})
		if (Number(response.status) === 404) {
			throw updateError("HTTP_STATUS", "The configured GitHub release repository was not found (HTTP 404).")
		}
		const releases = parseReleaseList(response.data)
		if (releases.length === 0) {
			break
		}
		allReleases.push(...releases)
		if (releases.length < RELEASES_PER_PAGE) {
			break
		}
	}

	return selectNewestCandidate(allReleases, currentVersion)
}

/**
 * Downloads and verifies the VSIX for a candidate returned by
 * `findReleaseUpdate`, then returns a private temporary path plus a cleanup
 * callback. The caller is responsible for asking the user for consent and for
 * installing the VSIX. Nothing is installed or executed here.
 */
export async function downloadVerifiedRelease(
	release: ReleaseCandidate,
	signal?: AbortSignal,
): Promise<ReleaseDownload> {
	const candidate = prepareCandidate(release)
	throwIfAborted(signal, "VSIX download")

	const directory = await createPrivateTempDirectory()
	const cleanup = async (): Promise<void> => {
		try {
			await removeTempDirectory(directory)
		} catch {
			// Cleanup is best effort; a failed removal must not mask the real result.
		}
	}

	try {
		const sidecarResponse = await fetchFollowingRedirects({
			url: candidate.checksumUrl,
			allowedHosts: DOWNLOAD_ALLOWED_HOSTS,
			responseType: "stream",
			maxBytes: MAX_SHA256_SIDECAR_BYTES,
			signal,
		})
		const sidecarText = (
			await readBoundedResponse(sidecarResponse, {
				maxBytes: MAX_SHA256_SIDECAR_BYTES,
				declaredBytes: declaredContentLength(sidecarResponse.headers),
				deadlineMs: SIDECAR_DEADLINE_MS,
				signal,
				label: "Checksum sidecar",
			})
		).toString("utf8")
		const expectedSha256 = parseSha256Sidecar(sidecarText, candidate.vsixAssetName)

		const vsixPath = path.join(directory, candidate.vsixAssetName)
		const vsixResponse = await fetchFollowingRedirects({
			url: candidate.vsixUrl,
			allowedHosts: DOWNLOAD_ALLOWED_HOSTS,
			responseType: "stream",
			maxBytes: MAX_VSIX_BYTES,
			signal,
		})
		const { bytes, sha256 } = await streamResponseToFile(vsixResponse, vsixPath, {
			maxBytes: MAX_VSIX_BYTES,
			declaredBytes: declaredContentLength(vsixResponse.headers),
			deadlineMs: VSIX_DEADLINE_MS,
			signal,
			label: "VSIX download",
		})

		assertDigestEquals(sha256, expectedSha256, "CHECKSUM_MISMATCH")
		if (candidate.assetDigest) {
			assertDigestEquals(sha256, candidate.assetDigest, "ASSET_DIGEST_MISMATCH")
		}
		if (candidate.assetSizeBytes !== undefined && candidate.assetSizeBytes !== bytes) {
			throw updateError(
				"ASSET_SIZE_MISMATCH",
				`Downloaded VSIX is ${bytes} bytes but the release asset declares ${candidate.assetSizeBytes}.`,
			)
		}

		const identity = await inspectVsixManifest(vsixPath, {
			packageName: VSIX_PACKAGE_NAME,
			publisher: VSIX_PUBLISHER,
			version: candidate.version,
		})

		const vscodeResult = checkEngineRange(identity.enginesVscode, getInstalledVscodeVersion())
		if (vscodeResult === "incompatible") {
			throw updateError(
				"ENGINE_INCOMPATIBLE",
				`VSIX requires VS Code ${identity.enginesVscode}, which this instance does not satisfy.`,
			)
		}
		const nodeResult = checkEngineRange(identity.enginesNode, process.versions.node, { ignoreExactPin: true })
		if (nodeResult === "incompatible") {
			throw updateError(
				"ENGINE_INCOMPATIBLE",
				`VSIX requires Node ${identity.enginesNode}, which this runtime does not satisfy.`,
			)
		}

		throwIfAborted(signal, "VSIX verification")
		return { vsixPath, cleanup }
	} catch (error) {
		await cleanup()
		throw error
	}
}
