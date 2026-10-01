import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { generateCodeVerifier, OpenAiCodexOAuthManager, parseCallbackInput } from "../oauth"

const TOKEN_RESPONSE = {
	access_token: "access-token",
	refresh_token: "refresh-token",
	expires_in: 3600,
	email: "user@example.com",
	token_type: "Bearer",
}

const callbackUrl = (state: string, code = "abc123") => `http://localhost:1455/auth/callback?code=${code}&state=${state}`

const stateFromAuthUrl = (authUrl: string): string => new URL(authUrl).searchParams.get("state") ?? ""

const createManager = () => {
	const secrets = {
		get: vi.fn().mockResolvedValue(undefined),
		store: vi.fn().mockResolvedValue(undefined),
		delete: vi.fn().mockResolvedValue(undefined),
	}

	const manager = new OpenAiCodexOAuthManager()
	manager.initialize({ secrets } as never)

	return { manager, secrets }
}

const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}) => {
	const ok = init.ok ?? true

	return {
		ok,
		status: init.status ?? (ok ? 200 : 400),
		statusText: ok ? "OK" : "Bad Request",
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response
}

const fetchMock = vi.fn()

describe("parseCallbackInput()", () => {
	it("reads the code and state from a full callback URL", () => {
		expect(parseCallbackInput(callbackUrl("xyz"))).toEqual({ code: "abc123", state: "xyz", error: undefined })
	})

	it("reads an error redirect", () => {
		expect(parseCallbackInput("http://localhost:1455/auth/callback?error=access_denied&state=xyz")).toEqual({
			code: undefined,
			state: "xyz",
			error: "access_denied",
		})
	})

	it("accepts a bare query string", () => {
		expect(parseCallbackInput("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz", error: undefined })
	})

	it("accepts the raw authorization code on its own", () => {
		const code = "ac_mQkzjHiHDYM4e0RN2rImLa_bb89OIVA00K0KdE9NS70.oRzifjq1zYplueMn385tbIsNneEn8chFdd2RwIPVPm4"

		expect(parseCallbackInput(code)).toEqual({ code })
	})

	it("strips surrounding quotes and whitespace", () => {
		expect(parseCallbackInput(`  "${callbackUrl("xyz")}"  `)).toEqual({
			code: "abc123",
			state: "xyz",
			error: undefined,
		})
	})

	it("returns an empty object for empty input", () => {
		expect(parseCallbackInput("   ")).toEqual({})
	})

	it("returns an empty object for an unparsable URL and for a query without code, state or error", () => {
		expect(parseCallbackInput("http://")).toEqual({})
		expect(parseCallbackInput("foo=bar")).toEqual({})
	})
})

describe("OpenAiCodexOAuthManager.submitCallbackUrl()", () => {
	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("exchanges a pasted callback URL and stores the credentials", async () => {
		const { manager, secrets } = createManager()
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))

		const credentials = await manager.submitCallbackUrl(callbackUrl(state))

		expect(credentials.access_token).toBe("access-token")
		expect(credentials.accountId).toBeUndefined()
		expect(secrets.store).toHaveBeenCalledTimes(1)

		const [key, value] = secrets.store.mock.calls[0]
		expect(key).toBe("openai-codex-oauth-credentials")
		expect(JSON.parse(value).access_token).toBe("access-token")

		// The exchange must keep the fixed loopback redirect and send the pending PKCE verifier.
		const [url, init] = fetchMock.mock.calls[0]
		expect(String(url)).toBe("https://auth.openai.com/oauth/token")

		const body = new URLSearchParams(String((init as RequestInit).body))
		expect(body.get("grant_type")).toBe("authorization_code")
		expect(body.get("code")).toBe("abc123")
		expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
		expect(body.get("code_verifier")).toBeTruthy()
	})

	it("accepts a bare authorization code with no state", async () => {
		const { manager } = createManager()
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))

		const credentials = await manager.submitCallbackUrl("bare-code-value")

		expect(credentials.access_token).toBe("access-token")
		expect(new URLSearchParams(String((fetchMock.mock.calls[0][1] as RequestInit).body)).get("code")).toBe(
			"bare-code-value",
		)
	})

	it("rejects a mismatched state without calling the token endpoint", async () => {
		const { manager, secrets } = createManager()
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))

		await expect(manager.submitCallbackUrl(callbackUrl("not-the-pending-state"))).rejects.toThrow(/State mismatch/)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(secrets.store).not.toHaveBeenCalled()
	})

	it("reports an error redirect instead of exchanging it", async () => {
		const { manager } = createManager()
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))

		await expect(
			manager.submitCallbackUrl("http://localhost:1455/auth/callback?error=access_denied"),
		).rejects.toThrow(/access_denied/)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("throws when no sign in is in progress", async () => {
		const { manager } = createManager()

		await expect(manager.submitCallbackUrl(callbackUrl("any"))).rejects.toThrow(/No sign in is in progress/)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("settles the waiting callback promise so the browser and paste paths share one result", async () => {
		const { manager } = createManager()
		const settle = vi.fn()
		const state = "pending-state"

		// Stand in for waitForCallback() without binding the fixed port.
		;(manager as unknown as { pendingAuth: unknown }).pendingAuth = {
			codeVerifier: generateCodeVerifier(),
			state,
			settle,
		}

		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const credentials = await manager.submitCallbackUrl(callbackUrl(state))

		expect(settle).toHaveBeenCalledWith({ credentials })
	})

	it("keeps the flow alive after a failed exchange so a later paste can still succeed", async () => {
		const { manager } = createManager()
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())

		fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, { ok: false, status: 400 }))
		await expect(manager.submitCallbackUrl(callbackUrl(state, "dead-code"))).rejects.toThrow(
			/Token exchange failed/,
		)

		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const credentials = await manager.submitCallbackUrl(callbackUrl(state, "fresh-code"))

		expect(credentials.access_token).toBe("access-token")
	})
})
