/**
 * Shared error type for the in-app updater pipeline.
 *
 * Every failure of the discovery/download/verification engine is reported as an
 * `UpdateVerificationError` with a stable machine readable `code`. Callers (for
 * example the parent `ReleaseUpdater`) can branch on `code` instead of parsing
 * messages.
 */

export type UpdateErrorCode =
	| "ABORTED"
	| "INVALID_CURRENT_VERSION"
	| "INVALID_SOURCE_URL"
	| "INVALID_CHECKSUM_SIDECAR"
	| "UNSAFE_REDIRECT"
	| "TOO_MANY_REDIRECTS"
	| "HTTP_STATUS"
	| "UNEXPECTED_RESPONSE"
	| "INCOMPLETE_RESPONSE"
	| "RESPONSE_TOO_LARGE"
	| "MISSING_ASSET"
	| "CHECKSUM_MISMATCH"
	| "ASSET_DIGEST_MISMATCH"
	| "ASSET_SIZE_MISMATCH"
	| "UNSAFE_ARCHIVE"
	| "MANIFEST_MISMATCH"
	| "ENGINE_INCOMPATIBLE"
	| "TEMPORARY_DIRECTORY"

export class UpdateVerificationError extends Error {
	readonly code: UpdateErrorCode

	constructor(code: UpdateErrorCode, message: string) {
		super(message)
		this.name = "UpdateVerificationError"
		this.code = code
	}
}

export function updateError(code: UpdateErrorCode, message: string): UpdateVerificationError {
	return new UpdateVerificationError(code, message)
}
