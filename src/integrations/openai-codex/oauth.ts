import * as crypto from "crypto"
import * as http from "http"
import { URL } from "url"
import type { ExtensionContext } from "vscode"
import { z } from "zod"

/**
 * OpenAI Codex OAuth Configuration
 *
 * Based on the OpenAI Codex OAuth implementation guide:
 * - ISSUER: https://auth.openai.com
 * - Authorization endpoint: https://auth.openai.com/oauth/authorize
 * - Token endpoint: https://auth.openai.com/oauth/token
 * - Fixed callback port: 1455
 * - Codex-specific params: codex_cli_simplified_flow=true, originator=roo-code
 */
export const OPENAI_CODEX_OAUTH_CONFIG = {
	authorizationEndpoint: "https://auth.openai.com/oauth/authorize",
	tokenEndpoint: "https://auth.openai.com/oauth/token",
	clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
	redirectUri: "http://localhost:1455/auth/callback",
	scopes: "openid profile email offline_access",
	callbackPort: 1455,
} as const

// Token storage key
const OPENAI_CODEX_CREDENTIALS_KEY = "openai-codex-oauth-credentials"

// Credentials schema
const openAiCodexCredentialsSchema = z.object({
	type: z.literal("openai-codex"),
	access_token: z.string().min(1),
	refresh_token: z.string().min(1),
	// expires is in milliseconds since epoch
	expires: z.number(),
	email: z.string().optional(),
	// ChatGPT account ID extracted from JWT claims (for ChatGPT-Account-Id header)
	accountId: z.string().optional(),
})

export type OpenAiCodexCredentials = z.infer<typeof openAiCodexCredentialsSchema>

// Token response schema from OpenAI
const tokenResponseSchema = z.object({
	access_token: z.string(),
	refresh_token: z.string().min(1).optional(),
	id_token: z.string().optional(),
	expires_in: z.number(),
	email: z.string().optional(),
	token_type: z.string().optional(),
})

/**
 * JWT claims structure for extracting ChatGPT account ID
 */
interface IdTokenClaims {
	chatgpt_account_id?: string
	organizations?: Array<{ id: string }>
	email?: string
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string
	}
}

/**
 * Parse JWT claims from a token
 * Returns undefined if the token is invalid or cannot be parsed
 */
function parseJwtClaims(token: string): IdTokenClaims | undefined {
	const parts = token.split(".")
	if (parts.length !== 3) return undefined
	try {
		// Use base64url decoding (Node.js Buffer handles this)
		const payload = Buffer.from(parts[1], "base64url").toString("utf-8")
		return JSON.parse(payload) as IdTokenClaims
	} catch {
		return undefined
	}
}

/**
 * Extract ChatGPT account ID from JWT claims
 * Checks multiple locations:
 * 1. Root-level chatgpt_account_id
 * 2. Nested under https://api.openai.com/auth
 * 3. First organization ID
 */
function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
	return (
		claims.chatgpt_account_id ||
		claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
		claims.organizations?.[0]?.id
	)
}

/**
 * Extract ChatGPT account ID from token response
 * Tries id_token first, then access_token
 */
function extractAccountId(tokens: { id_token?: string; access_token: string }): string | undefined {
	// Try id_token first (more reliable source)
	if (tokens.id_token) {
		const claims = parseJwtClaims(tokens.id_token)
		const accountId = claims && extractAccountIdFromClaims(claims)
		if (accountId) return accountId
	}
	// Fall back to access_token
	if (tokens.access_token) {
		const claims = parseJwtClaims(tokens.access_token)
		return claims ? extractAccountIdFromClaims(claims) : undefined
	}
	return undefined
}

class OpenAiCodexOAuthTokenError extends Error {
	public readonly status?: number
	public readonly errorCode?: string

	constructor(message: string, opts?: { status?: number; errorCode?: string }) {
		super(message)
		this.name = "OpenAiCodexOAuthTokenError"
		this.status = opts?.status
		this.errorCode = opts?.errorCode
	}

	public isLikelyInvalidGrant(): boolean {
		if (this.errorCode && /invalid_grant/i.test(this.errorCode)) {
			return true
		}
		if (this.status === 400 || this.status === 401 || this.status === 403) {
			return /invalid_grant|revoked|expired|invalid refresh/i.test(this.message)
		}
		return false
	}
}

function parseOAuthErrorDetails(errorText: string): { errorCode?: string; errorMessage?: string } {
	try {
		const json: unknown = JSON.parse(errorText)
		if (!json || typeof json !== "object") {
			return {}
		}

		const obj = json as Record<string, unknown>
		const errorField = obj.error

		const errorCode: string | undefined =
			typeof errorField === "string"
				? errorField
				: errorField &&
					  typeof errorField === "object" &&
					  typeof (errorField as Record<string, unknown>).type === "string"
					? ((errorField as Record<string, unknown>).type as string)
					: undefined

		const errorDescription = obj.error_description
		const errorMessageFromError =
			errorField && typeof errorField === "object" ? (errorField as Record<string, unknown>).message : undefined

		const errorMessage: string | undefined =
			typeof errorDescription === "string"
				? errorDescription
				: typeof errorMessageFromError === "string"
					? errorMessageFromError
					: typeof obj.message === "string"
						? obj.message
						: undefined

		return { errorCode, errorMessage }
	} catch {
		return {}
	}
}

/**
 * Generates a cryptographically random PKCE code verifier
 * Must be 43-128 characters long using unreserved characters
 */
export function generateCodeVerifier(): string {
	const buffer = crypto.randomBytes(32)
	return buffer.toString("base64url")
}

/**
 * Generates the PKCE code challenge from the verifier using S256 method
 */
export function generateCodeChallenge(verifier: string): string {
	const hash = crypto.createHash("sha256").update(verifier).digest()
	return hash.toString("base64url")
}

/**
 * Generates a random state parameter for CSRF protection
 */
export function generateState(): string {
	return crypto.randomBytes(16).toString("hex")
}

/**
 * Builds the authorization URL for OpenAI Codex OAuth flow
 * Includes Codex-specific parameters per the implementation guide
 */
export function buildAuthorizationUrl(codeChallenge: string, state: string): string {
	const params = new URLSearchParams({
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
		scope: OPENAI_CODEX_OAUTH_CONFIG.scopes,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		response_type: "code",
		state,
		// Codex-specific parameters
		codex_cli_simplified_flow: "true",
		originator: "roo-code",
	})

	return `${OPENAI_CODEX_OAUTH_CONFIG.authorizationEndpoint}?${params.toString()}`
}

/**
 * Parses a callback value pasted in by the user into its parts.
 *
 * Accepts any of:
 * - the full callback URL from the browser address bar, including an error redirect
 * - a bare query string such as `code=...&state=...`
 * - the raw authorization code on its own
 *
 * This exists because the fixed loopback redirect only works when the browser runs on the same
 * machine as the extension host. Remote setups (code-server, SSH remote, WSL, dev containers)
 * cannot complete the redirect, so the user has to hand the value back.
 */
export function parseCallbackInput(input: string): { code?: string; state?: string; error?: string } {
	const raw = (input ?? "").trim().replace(/^["'`]+|["'`]+$/g, "")
	if (!raw) {
		return {}
	}

	// Anything shaped like a URL or a query string is parsed as one. Anything else is treated as a
	// bare authorization code, which is what a user has when the redirect never reaches the host.
	if (/^https?:\/\//i.test(raw) || raw.startsWith("?") || raw.includes("=")) {
		const withProtocol = /^https?:\/\//i.test(raw)
			? raw
			: `http://localhost/auth/callback${raw.startsWith("?") ? "" : "?"}${raw}`

		try {
			const params = new URL(withProtocol).searchParams
			const code = params.get("code") ?? undefined
			const state = params.get("state") ?? undefined
			const error = params.get("error") ?? undefined
			return code || state || error ? { code, state, error } : {}
		} catch {
			return {}
		}
	}

	return { code: raw }
}

/**
 * Exchanges the authorization code for tokens
 * Important: Uses application/x-www-form-urlencoded (not JSON)
 * Important: state must NOT be included in token exchange body
 */
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<OpenAiCodexCredentials> {
	// Per the implementation guide: use application/x-www-form-urlencoded
	// and do NOT include state in the body (OpenAI returns error if included)
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		code,
		redirect_uri: OPENAI_CODEX_OAUTH_CONFIG.redirectUri,
		code_verifier: codeVerifier,
	})

	const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30000),
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Token exchange failed: ${response.status} ${response.statusText} - ${errorText}`)
	}

	const data = await response.json()
	const tokenResponse = tokenResponseSchema.parse(data)

	if (!tokenResponse.refresh_token) {
		throw new Error("Token exchange did not return a refresh_token")
	}

	// Per the implementation guide: expires is in milliseconds since epoch
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000

	// Extract ChatGPT account ID from JWT claims
	const accountId = extractAccountId({
		id_token: tokenResponse.id_token,
		access_token: tokenResponse.access_token,
	})

	return {
		type: "openai-codex",
		access_token: tokenResponse.access_token,
		refresh_token: tokenResponse.refresh_token,
		expires: expiresAt,
		email: tokenResponse.email,
		accountId,
	}
}

/**
 * Refreshes the access token using the refresh token
 * Uses application/x-www-form-urlencoded (not JSON)
 */
export async function refreshAccessToken(credentials: OpenAiCodexCredentials): Promise<OpenAiCodexCredentials> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: OPENAI_CODEX_OAUTH_CONFIG.clientId,
		refresh_token: credentials.refresh_token,
	})

	const response = await fetch(OPENAI_CODEX_OAUTH_CONFIG.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: body.toString(),
		signal: AbortSignal.timeout(30000),
	})

	if (!response.ok) {
		const errorText = await response.text()
		const { errorCode, errorMessage } = parseOAuthErrorDetails(errorText)
		const details = errorMessage ? errorMessage : errorText
		throw new OpenAiCodexOAuthTokenError(
			`Token refresh failed: ${response.status} ${response.statusText}${details ? ` - ${details}` : ""}`,
			{ status: response.status, errorCode },
		)
	}

	const data = await response.json()
	const tokenResponse = tokenResponseSchema.parse(data)

	// Per the implementation guide: expires is in milliseconds since epoch
	const expiresAt = Date.now() + tokenResponse.expires_in * 1000

	// Extract new account ID from refreshed tokens, or preserve existing one
	const newAccountId = extractAccountId({
		id_token: tokenResponse.id_token,
		access_token: tokenResponse.access_token,
	})

	return {
		type: "openai-codex",
		access_token: tokenResponse.access_token,
		refresh_token: tokenResponse.refresh_token ?? credentials.refresh_token,
		expires: expiresAt,
		email: tokenResponse.email ?? credentials.email,
		// Prefer newly extracted accountId, fall back to existing
		accountId: newAccountId ?? credentials.accountId,
	}
}

/**
 * Checks if the credentials are expired (with 5 minute buffer)
 * Per the implementation guide: expires is in milliseconds since epoch
 */
export function isTokenExpired(credentials: OpenAiCodexCredentials): boolean {
	const bufferMs = 5 * 60 * 1000 // 5 minutes buffer
	return Date.now() >= credentials.expires - bufferMs
}

/**
 * OpenAiCodexOAuthManager - Handles OAuth flow and token management
 */
export class OpenAiCodexOAuthManager {
	private context: ExtensionContext | null = null
	private credentials: OpenAiCodexCredentials | null = null
	private logFn: ((message: string) => void) | null = null
	private generation = 0
	// Credential invalidation must not cancel an independent pending authorization flow.
	private credentialRevision = 0
	private storageQueue: Promise<unknown> = Promise.resolve()
	private refreshPromise: Promise<OpenAiCodexCredentials | null> | null = null
	private pendingAuth: {
		generation: number
		codeVerifier: string
		state: string
		exchanging?: boolean
		callbackPromise?: Promise<OpenAiCodexCredentials>
		server?: http.Server
		/**
		 * Settles the promise returned by waitForCallback. Kept on the pending flow so a callback
		 * URL pasted in by the user resolves the same waiter the browser redirect would have.
		 */
		settle?: (outcome: { credentials?: OpenAiCodexCredentials; error?: unknown }) => void
	} | null = null

	private log(message: string): void {
		if (this.logFn) {
			this.logFn(message)
		} else {
			console.log(message)
		}
	}

	private logError(message: string, error?: unknown): void {
		const details = error instanceof Error ? error.message : error !== undefined ? String(error) : undefined
		const full = details ? `${message} ${details}` : message
		this.log(full)
		console.error(full)
	}

	/**
	 * Initialize the OAuth manager with VS Code extension context
	 */
	initialize(context: ExtensionContext, logFn?: (message: string) => void): void {
		this.context = context
		this.logFn = logFn ?? null
	}

	/**
	 * Force a refresh using the stored refresh token even if the access token is not expired.
	 * Useful when the server invalidates an access token early.
	 */
	async forceRefreshAccessToken(): Promise<string | null> {
		const generation = this.generation
		if (!this.credentials) {
			await this.loadCredentials()
		}

		if (generation !== this.generation || !this.credentials) {
			return null
		}

		const refreshed = await this.refreshCredentials()
		return generation === this.generation ? (refreshed?.access_token ?? null) : null
	}

	private refreshCredentials(): Promise<OpenAiCodexCredentials | null> {
		if (this.refreshPromise) {
			return this.refreshPromise
		}
		const generation = this.generation
		const credentialRevision = this.credentialRevision
		const credentials = this.credentials
		if (!credentials) return Promise.resolve(null)

		const refresh = (async () => {
			try {
				const refreshed = await refreshAccessToken(credentials)
				await this.persistCredentials(refreshed, generation, false, credentialRevision)
				return generation === this.generation && this.credentialRevision === credentialRevision + 1
					? refreshed
					: null
			} catch (error) {
				// A stale failure must not clear credentials belonging to a newer sign-in.
				if (generation === this.generation && credentialRevision === this.credentialRevision) {
					this.logError("[openai-codex-oauth] Failed to refresh token:", error)
					if (error instanceof OpenAiCodexOAuthTokenError && error.isLikelyInvalidGrant()) {
						await this.invalidateCredentials(credentialRevision)
					}
				}
				return null
			}
		})()
		this.refreshPromise = refresh
		return refresh.finally(() => {
			if (this.refreshPromise === refresh) this.refreshPromise = null
		})
	}

	private async invalidateCredentials(credentialRevision: number): Promise<void> {
		if (credentialRevision !== this.credentialRevision) return
		this.credentials = null
		const invalidatedRevision = ++this.credentialRevision
		this.refreshPromise = null
		const context = this.context
		if (!context) return

		await this.withStorage(async () => {
			// A replacement already writing or queued ahead of this deletion can still commit.
			// Delete only the invalidated identity, never that replacement's credentials.
			if (invalidatedRevision === this.credentialRevision) {
				await context.secrets.delete(OPENAI_CODEX_CREDENTIALS_KEY)
			}
		})
	}

	private withStorage<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.storageQueue.then(operation)
		// A failed operation must not prevent subsequent deletion or persistence.
		this.storageQueue = result.catch(() => undefined)
		return result
	}

	/**
	 * Load credentials from storage
	 */
	async loadCredentials(): Promise<OpenAiCodexCredentials | null> {
		const context = this.context
		const generation = this.generation
		const credentialRevision = this.credentialRevision
		if (!context) {
			return null
		}

		try {
			return await this.withStorage(async () => {
				if (generation !== this.generation || credentialRevision !== this.credentialRevision) return null
				const credentialsJson = await context.secrets.get(OPENAI_CODEX_CREDENTIALS_KEY)
				if (
					generation !== this.generation ||
					credentialRevision !== this.credentialRevision ||
					!credentialsJson
				) {
					return null
				}
				this.credentials = openAiCodexCredentialsSchema.parse(JSON.parse(credentialsJson))
				return this.credentials
			})
		} catch (error) {
			this.logError("[openai-codex-oauth] Failed to load credentials:", error)
			return null
		}
	}

	/**
	 * Save credentials to storage
	 */
	async saveCredentials(credentials: OpenAiCodexCredentials): Promise<void> {
		// An explicit replacement also invalidates refreshes for the previous account.
		this.cancelAuthorizationFlow()
		await this.persistCredentials(credentials, this.generation, true)
	}

	private async persistCredentials(
		credentials: OpenAiCodexCredentials,
		generation: number,
		replace = false,
		credentialRevision?: number,
	): Promise<number> {
		const context = this.context
		if (!context) {
			throw new Error("OAuth manager not initialized")
		}

		const isCurrent = () =>
			generation === this.generation &&
			(credentialRevision === undefined || credentialRevision === this.credentialRevision)

		return this.withStorage(async () => {
			if (!isCurrent()) throw new Error("Authentication operation cancelled")
			await context.secrets.store(OPENAI_CODEX_CREDENTIALS_KEY, JSON.stringify(credentials))
			if (!isCurrent()) {
				// SecretStorage cannot abort an in-flight write. Restore the last committed state
				// before allowing any newer save/delete/read to use storage.
				if (this.credentials) {
					await context.secrets.store(OPENAI_CODEX_CREDENTIALS_KEY, JSON.stringify(this.credentials))
				} else {
					await context.secrets.delete(OPENAI_CODEX_CREDENTIALS_KEY)
				}
				throw new Error("Authentication operation cancelled")
			}
			this.credentials = credentials
			this.credentialRevision++
			if (replace) {
				// Also discard refreshes started against the old account during this write.
				// Do this before releasing the queue to any pending refresh persistence.
				this.generation++
				this.refreshPromise = null
			}
			return this.generation
		})
	}

	/**
	 * Clear credentials from storage
	 */
	async clearCredentials(): Promise<void> {
		this.cancelAuthorizationFlow()
		this.credentials = null
		this.credentialRevision++
		const context = this.context
		if (!context) {
			return
		}

		await this.withStorage(async () => context.secrets.delete(OPENAI_CODEX_CREDENTIALS_KEY))
	}

	/**
	 * Get a valid access token, refreshing if necessary
	 */
	async getAccessToken(): Promise<string | null> {
		const generation = this.generation
		// Try to load credentials if not already loaded
		if (!this.credentials) {
			await this.loadCredentials()
		}

		if (generation !== this.generation || !this.credentials) {
			return null
		}

		// Check if token is expired and refresh if needed
		if (isTokenExpired(this.credentials)) {
			const refreshed = await this.refreshCredentials()
			return generation === this.generation ? (refreshed?.access_token ?? null) : null
		}

		return this.credentials.access_token
	}

	/**
	 * Get the user's email from credentials
	 */
	async getEmail(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.email || null
	}

	/**
	 * Get the ChatGPT account ID from credentials
	 * Used for the ChatGPT-Account-Id header required by the Codex API
	 */
	async getAccountId(): Promise<string | null> {
		if (!this.credentials) {
			await this.loadCredentials()
		}
		return this.credentials?.accountId || null
	}

	/**
	 * Check if the user is authenticated
	 */
	async isAuthenticated(): Promise<boolean> {
		const token = await this.getAccessToken()
		return token !== null
	}

	/**
	 * Start the OAuth authorization flow
	 * Returns the authorization URL to open in browser
	 */
	startAuthorizationFlow(): string {
		// Cancel any existing authorization flow before starting a new one
		this.cancelAuthorizationFlow()

		const codeVerifier = generateCodeVerifier()
		const codeChallenge = generateCodeChallenge(codeVerifier)
		const state = generateState()

		this.pendingAuth = {
			generation: this.generation,
			codeVerifier,
			state,
		}

		return buildAuthorizationUrl(codeChallenge, state)
	}

	/**
	 * Start a local server to receive the OAuth callback
	 * Returns a promise that resolves when authentication is complete
	 */
	async waitForCallback(): Promise<OpenAiCodexCredentials> {
		const pendingAuth = this.pendingAuth
		if (!pendingAuth) {
			throw new Error("No pending authorization flow")
		}

		if (pendingAuth.callbackPromise) return pendingAuth.callbackPromise

		pendingAuth.callbackPromise = new Promise((resolve, reject) => {
			// A callback URL pasted in by the user must settle the same promise the browser
			// redirect would have settled.
			pendingAuth.settle = (outcome) => {
				if (outcome.credentials) {
					resolve(outcome.credentials)
				} else {
					reject(outcome.error ?? new Error("Authentication failed"))
				}
			}

			const server = http.createServer(async (req, res) => {
				try {
					const url = new URL(req.url || "", `http://localhost:${OPENAI_CODEX_OAUTH_CONFIG.callbackPort}`)
					if (req.method !== "GET") {
						res.writeHead(405)
						res.end("Method Not Allowed")
						return
					}

					if (url.pathname !== "/auth/callback") {
						res.writeHead(404)
						res.end("Not Found")
						return
					}

					const code = url.searchParams.get("code")
					const state = url.searchParams.get("state")
					const error = url.searchParams.get("error")

					// Validate state before accepting either a success or an OAuth error.
					// Unrelated local requests must not terminate the real sign-in.
					if (
						!state ||
						(!code && !error) ||
						(code && error) ||
						url.searchParams.getAll("state").length !== 1
					) {
						res.writeHead(400)
						res.end("Missing code or state parameter")
						return
					}

					if (state !== pendingAuth.state || this.pendingAuth !== pendingAuth) {
						res.writeHead(400)
						res.end("State mismatch - possible CSRF attack")
						return
					}

					if (pendingAuth.exchanging) {
						res.writeHead(409)
						res.end("Authentication exchange already in progress")
						return
					}

					if (error) {
						res.writeHead(400)
						res.end("Authentication failed")
						pendingAuth.settle?.({ error: new Error(`OAuth error: ${error}`) })
						this.cancelAuthorizationFlow()
						return
					}

					try {
						// Note: state is validated above but not passed to exchangeCodeForTokens
						// per the implementation guide (OpenAI rejects it)
						await this.completeAuthorization(pendingAuth, code!)

						res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
						res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Authentication Successful</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    height: 100vh;
    margin: 0;
    background: linear-gradient(135deg, #10a37f 0%, #0d8f6f 100%);
    color: white;
  }
  .container {
    text-align: center;
    padding: 2rem;
  }
  h1 { font-size: 2rem; margin-bottom: 1rem; }
  p { opacity: 0.9; }
</style>
</head>
<body>
<div class="container">
<h1>&#10003; Authentication Successful</h1>
<p>You can close this window and return to VS Code.</p>
</div>
<script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`)
					} catch (exchangeError) {
						res.writeHead(500)
						res.end("Token exchange failed")
						this.logError("[openai-codex-oauth] Callback token exchange failed:", exchangeError)
					}
				} catch {
					res.writeHead(400)
					res.end("Invalid callback request")
				}
			})

			server.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(timeout)
				// pendingAuth is deliberately kept. The manual "paste the callback URL" path still
				// works without a listening socket, for example when the Codex CLI already holds 1455.
				if (err.code === "EADDRINUSE") {
					reject(
						new Error(
							`Port ${OPENAI_CODEX_OAUTH_CONFIG.callbackPort} is already in use. ` +
								`Close the other application using it, or complete sign in by pasting the ` +
								`callback URL from your browser address bar.`,
						),
					)
				} else {
					reject(err)
				}
			})

			// Set a timeout for the callback
			const timeout = setTimeout(
				() => {
					if (this.pendingAuth === pendingAuth) {
						pendingAuth.settle?.({ error: new Error("Authentication timed out") })
						this.cancelAuthorizationFlow()
					}
				},
				5 * 60 * 1000,
			) // 5 minutes

			// Listen only on IPv4 loopback, never a wildcard interface. Browsers can reach
			// this address using the registered http://localhost redirect URI.
			pendingAuth.server = server
			server.listen(OPENAI_CODEX_OAUTH_CONFIG.callbackPort, "127.0.0.1", () => {
				if (this.pendingAuth !== pendingAuth) server.close()
			})

			// Clear timeout when server closes
			server.on("close", () => {
				clearTimeout(timeout)
			})
		})
		return pendingAuth.callbackPromise
	}

	/**
	 * Completes a sign in started by startAuthorizationFlow/waitForCallback using a callback URL
	 * the user copied out of the browser.
	 *
	 * Required whenever the browser cannot reach the loopback listener, which is always the case
	 * when the extension host is remote (code-server, SSH remote, WSL, dev container) and the
	 * browser runs on the user's own machine: there `localhost:1455` is the user's machine, not
	 * the machine hosting this extension.
	 */
	async submitCallbackUrl(input: string): Promise<OpenAiCodexCredentials> {
		const pending = this.pendingAuth
		if (!pending) {
			throw new Error(
				"No sign in is in progress. Click Sign in, finish the login in the browser, then paste the callback URL.",
			)
		}

		const { code, state, error } = parseCallbackInput(input)
		if (error) {
			throw new Error(`The login page reported an error: ${error}`)
		}
		if (!code) {
			throw new Error("No authorization code found. Paste the full callback URL from the browser address bar.")
		}
		if (state && state !== pending.state) {
			throw new Error("State mismatch. Click Sign in again and paste the URL from the new attempt.")
		}

		this.log("[openai-codex-oauth] Completing sign in from a pasted callback URL")

		return this.completeAuthorization(pending, code)
	}

	private async completeAuthorization(
		pending: NonNullable<OpenAiCodexOAuthManager["pendingAuth"]>,
		code: string,
	): Promise<OpenAiCodexCredentials> {
		if (pending.exchanging) throw new Error("Authentication exchange already in progress")
		pending.exchanging = true
		try {
			const credentials = await exchangeCodeForTokens(code, pending.codeVerifier)
			if (this.pendingAuth !== pending || pending.generation !== this.generation) {
				throw new Error("Authentication operation cancelled")
			}
			// Discard any refresh of the previous account, including one started during sign-in.
			pending.generation = ++this.generation
			this.refreshPromise = null
			const generation = await this.persistCredentials(credentials, pending.generation, true)
			if (this.pendingAuth !== pending || generation !== this.generation) {
				throw new Error("Authentication operation cancelled")
			}
			this.pendingAuth = null
			pending.server?.close()
			pending.settle?.({ credentials })
			return credentials
		} finally {
			pending.exchanging = false
		}
	}

	/**
	 * Cancel any pending authorization flow
	 */
	cancelAuthorizationFlow(): void {
		this.generation++
		this.refreshPromise = null
		const pending = this.pendingAuth
		this.pendingAuth = null
		pending?.server?.close()
		pending?.settle?.({ error: new Error("Authentication operation cancelled") })
	}

	/**
	 * Get the current credentials (for display purposes)
	 */
	getCredentials(): OpenAiCodexCredentials | null {
		return this.credentials
	}
}

// Singleton instance
export const openAiCodexOAuthManager = new OpenAiCodexOAuthManager()
