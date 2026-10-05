import * as http from "http"
import { once } from "events"
import type { AddressInfo } from "net"
import nock from "nock"

import { OpenAiCodexOAuthManager, parseCallbackInput, type OpenAiCodexCredentials } from "../oauth"

const TOKEN_RESPONSE = {
	access_token: "access-token",
	refresh_token: "refresh-token",
	expires_in: 3600,
	email: "user@example.com",
	token_type: "Bearer",
}

const callbackUrl = (state: string, code = "abc123") =>
	`http://localhost:1455/auth/callback?code=${code}&state=${state}`

const stateFromAuthUrl = (authUrl: string): string => new URL(authUrl).searchParams.get("state") ?? ""

const deferred = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

const oldCredentials: OpenAiCodexCredentials = {
	type: "openai-codex",
	access_token: "old-access",
	refresh_token: "old-refresh",
	expires: 0,
}

const createManager = () => {
	let stored: string | undefined
	const secrets = {
		get: vi.fn(async () => stored),
		store: vi.fn(async (_key: string, value: string) => {
			stored = value
		}),
		delete: vi.fn(async () => {
			stored = undefined
		}),
	}

	const manager = new OpenAiCodexOAuthManager()
	manager.initialize({ secrets } as never)

	return { manager, secrets, storedCredentials: () => (stored ? JSON.parse(stored) : null) }
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

describe("OAuth lifecycle races", () => {
	beforeEach(() => {
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
	})

	afterEach(() => vi.unstubAllGlobals())

	for (const method of ["getAccessToken", "forceRefreshAccessToken"] as const) {
		it.each(["signout", "cancel", "replacement"] as const)(`discards ${method} after %s`, async (action) => {
			const { manager, secrets, storedCredentials } = createManager()
			await manager.saveCredentials(oldCredentials)
			secrets.store.mockClear()
			const response = deferred<Response>()
			fetchMock.mockReturnValueOnce(response.promise)
			const refresh = manager[method]()
			if (action === "signout") await manager.clearCredentials()
			else if (action === "cancel") manager.cancelAuthorizationFlow()
			else manager.startAuthorizationFlow()
			response.resolve(jsonResponse(TOKEN_RESPONSE))
			expect(await refresh).toBeNull()
			expect(secrets.store).not.toHaveBeenCalled()
			expect(storedCredentials()).toEqual(action === "signout" ? null : oldCredentials)
			expect(manager.getCredentials()).toEqual(action === "signout" ? null : oldCredentials)
			manager.cancelAuthorizationFlow()
		})
	}

	it.each(["signout", "cancel", "replacement"] as const)("discards a manual exchange after %s", async (action) => {
		const { manager, secrets, storedCredentials } = createManager()
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		const response = deferred<Response>()
		fetchMock.mockReturnValueOnce(response.promise)
		const exchange = manager.submitCallbackUrl(callbackUrl(state))
		const rejected = expect(exchange).rejects.toThrow(/cancelled/)
		if (action === "signout") await manager.clearCredentials()
		else if (action === "cancel") manager.cancelAuthorizationFlow()
		else manager.startAuthorizationFlow()
		response.resolve(jsonResponse(TOKEN_RESPONSE))
		await rejected
		expect(secrets.store).not.toHaveBeenCalled()
		expect(storedCredentials()).toBeNull()
		expect(manager.getCredentials()).toBeNull()
		if (action === "replacement") {
			fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
			await expect(manager.submitCallbackUrl("new-code")).resolves.toMatchObject({ access_token: "access-token" })
		}
	})

	it("does not let an obsolete invalid-grant failure delete a newer account", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const response = deferred<Response>()
		fetchMock.mockReturnValueOnce(response.promise)
		const refresh = manager.getAccessToken()
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		await manager.submitCallbackUrl("new-code")
		response.resolve(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		expect(await refresh).toBeNull()
		expect(secrets.delete).not.toHaveBeenCalled()
		expect(storedCredentials().access_token).toBe("access-token")
	})

	it("keeps a newer refresh deduplicated when an obsolete refresh completes", async () => {
		const { manager, secrets } = createManager()
		await manager.saveCredentials(oldCredentials)
		secrets.store.mockClear()
		const oldResponse = deferred<Response>()
		const newResponse = deferred<Response>()
		fetchMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise)
		const oldRefresh = manager.getAccessToken()
		manager.cancelAuthorizationFlow()
		const newRefresh = manager.forceRefreshAccessToken()
		oldResponse.resolve(jsonResponse(TOKEN_RESPONSE))
		expect(await oldRefresh).toBeNull()
		const concurrent = manager.getAccessToken()
		expect(fetchMock).toHaveBeenCalledTimes(2)
		newResponse.resolve(jsonResponse(TOKEN_RESPONSE))
		expect(await newRefresh).toBe("access-token")
		expect(await concurrent).toBe("access-token")
		expect(secrets.store).toHaveBeenCalledTimes(1)
	})

	it.each(["signout", "cancel", "replacement"] as const)("orders an in-flight store before %s", async (action) => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const storeStarted = deferred<void>()
		const storeRelease = deferred<void>()
		const originalStore = secrets.store.getMockImplementation()!
		secrets.store.mockImplementationOnce(async (key, value) => {
			storeStarted.resolve()
			await storeRelease.promise
			await originalStore(key, value)
		})
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValue(jsonResponse(TOKEN_RESPONSE))
		const exchange = manager.submitCallbackUrl("old-code")
		const rejected = expect(exchange).rejects.toThrow(/cancelled/)
		await storeStarted.promise
		let next: Promise<unknown> | undefined
		if (action === "signout") next = manager.clearCredentials()
		else if (action === "cancel") manager.cancelAuthorizationFlow()
		else {
			manager.startAuthorizationFlow()
			fetchMock.mockResolvedValueOnce(jsonResponse({ ...TOKEN_RESPONSE, access_token: "replacement" }))
			next = manager.submitCallbackUrl("new-code")
		}
		expect(secrets.delete).not.toHaveBeenCalled()
		storeRelease.resolve()
		await rejected
		await next
		expect(storedCredentials()).toEqual(manager.getCredentials())
		if (action === "signout") expect(storedCredentials()).toBeNull()
		else expect(storedCredentials().access_token).toBe(action === "cancel" ? "old-access" : "replacement")
	})

	it("orders a newer sign-in after a deferred sign-out deletion", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const started = deferred<void>()
		const release = deferred<void>()
		const originalDelete = secrets.delete.getMockImplementation()!
		secrets.delete.mockImplementationOnce(async () => {
			started.resolve()
			await release.promise
			await originalDelete()
		})
		const signout = manager.clearCredentials()
		await started.promise
		manager.startAuthorizationFlow()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const exchange = manager.submitCallbackUrl("new-code")
		release.resolve()
		await signout
		await exchange
		expect(storedCredentials().access_token).toBe("access-token")
		expect(manager.getCredentials()).toEqual(storedCredentials())
	})

	it("orders a pending sign-in after a deferred invalid-grant deletion", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		const started = deferred<void>()
		const release = deferred<void>()
		const originalDelete = secrets.delete.getMockImplementation()!
		secrets.delete.mockImplementationOnce(async () => {
			started.resolve()
			await release.promise
			await originalDelete()
		})
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		const refresh = manager.isAuthenticated()
		await started.promise
		expect(manager.getCredentials()).toBeNull()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const exchange = manager.submitCallbackUrl(callbackUrl(state))
		// Observe failures immediately so the regression does not produce an unhandled rejection.
		void exchange.catch(() => undefined)
		await new Promise((resolve) => setImmediate(resolve))
		expect(secrets.store).toHaveBeenCalledTimes(1)
		release.resolve()
		expect(await refresh).toBe(false)
		await expect(exchange).resolves.toMatchObject({ access_token: "access-token" })
		expect(storedCredentials()).toEqual(manager.getCredentials())
		expect(storedCredentials().access_token).toBe("access-token")
	})

	it("does not reload invalidated credentials from deferred or queued reads", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		const response = deferred<Response>()
		fetchMock.mockReturnValueOnce(response.promise)
		const refresh = manager.isAuthenticated()
		const started = deferred<void>()
		const release = deferred<string>()
		secrets.get.mockImplementationOnce(() => {
			started.resolve()
			return release.promise
		})
		const loading = manager.loadCredentials()
		await started.promise
		const queuedLoading = manager.loadCredentials()
		response.resolve(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		await new Promise((resolve) => setImmediate(resolve))
		expect(manager.getCredentials()).toBeNull()
		release.resolve(JSON.stringify(oldCredentials))
		expect(await loading).toBeNull()
		expect(await queuedLoading).toBeNull()
		expect(await refresh).toBe(false)
		expect(manager.getCredentials()).toBeNull()
		expect(storedCredentials()).toBeNull()
		expect(secrets.get).toHaveBeenCalledTimes(1)
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		await expect(manager.submitCallbackUrl(callbackUrl(state))).resolves.toMatchObject({
			access_token: "access-token",
		})
	})

	it("does not restore invalid credentials when an obsolete refresh write finishes", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const started = deferred<void>()
		const release = deferred<void>()
		const originalStore = secrets.store.getMockImplementation()!
		secrets.store.mockImplementationOnce(async (key, value) => {
			started.resolve()
			await release.promise
			await originalStore(key, value)
		})
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const obsoleteRefresh = manager.getAccessToken()
		await started.promise
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		const invalidRefresh = manager.isAuthenticated()
		await new Promise((resolve) => setImmediate(resolve))
		expect(manager.getCredentials()).toBeNull()
		release.resolve()
		expect(await obsoleteRefresh).toBeNull()
		expect(await invalidRefresh).toBe(false)
		expect(manager.getCredentials()).toBeNull()
		expect(storedCredentials()).toBeNull()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		await manager.submitCallbackUrl(callbackUrl(state))
		expect(storedCredentials().access_token).toBe("access-token")
	})

	it("invalidates the refreshed identity even when storage reloads its credential object", async () => {
		const { manager, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		const response = deferred<Response>()
		fetchMock.mockReturnValueOnce(response.promise)
		const refresh = manager.getAccessToken()
		const reloaded = await manager.loadCredentials()
		expect(reloaded).toEqual(oldCredentials)
		expect(reloaded).not.toBe(oldCredentials)
		response.resolve(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		expect(await refresh).toBeNull()
		expect(manager.getCredentials()).toBeNull()
		expect(storedCredentials()).toBeNull()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		await manager.submitCallbackUrl(callbackUrl(state))
		expect(storedCredentials().access_token).toBe("access-token")
	})

	for (const action of ["sign-in", "explicit save"] as const) {
		it.each(["during", "after"] as const)(
			`preserves a ${action} when an old refresh fails %s its credential write`,
			async (timing) => {
				const { manager, secrets, storedCredentials } = createManager()
				await manager.saveCredentials(oldCredentials)
				const started = deferred<void>()
				const release = deferred<void>()
				const originalStore = secrets.store.getMockImplementation()!
				secrets.store.mockImplementationOnce(async (key, value) => {
					started.resolve()
					await release.promise
					await originalStore(key, value)
				})
				manager.startAuthorizationFlow()
				fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
				const replacement =
					action === "sign-in"
						? manager.submitCallbackUrl("new-code")
						: manager.saveCredentials({ ...oldCredentials, access_token: "access-token" })
				void replacement.catch(() => undefined)
				await started.promise
				const response = deferred<Response>()
				fetchMock.mockReset().mockReturnValueOnce(response.promise)
				const refresh = manager.forceRefreshAccessToken()
				if (timing === "after") {
					release.resolve()
					await replacement
				}
				response.resolve(jsonResponse({ error: "invalid_grant" }, { ok: false }))
				await new Promise((resolve) => setImmediate(resolve))
				release.resolve()
				await replacement
				expect(await refresh).toBeNull()
				expect(secrets.delete).not.toHaveBeenCalled()
				expect(storedCredentials().access_token).toBe("access-token")
				expect(manager.getCredentials()).toEqual(storedCredentials())
			},
		)
	}

	it.each(["sign-in", "explicit save"] as const)(
		"discards refreshes started during a %s credential write",
		async (action) => {
			const { manager, secrets, storedCredentials } = createManager()
			await manager.saveCredentials(oldCredentials)
			const started = deferred<void>()
			const release = deferred<void>()
			const originalStore = secrets.store.getMockImplementation()!
			secrets.store.mockImplementationOnce(async (key, value) => {
				started.resolve()
				await release.promise
				await originalStore(key, value)
			})
			manager.startAuthorizationFlow()
			fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
			const replacement =
				action === "sign-in"
					? manager.submitCallbackUrl("new-code")
					: manager.saveCredentials({ ...oldCredentials, access_token: "access-token" })
			await started.promise
			const response = deferred<Response>()
			fetchMock.mockReset().mockReturnValueOnce(response.promise)
			const refresh = manager.forceRefreshAccessToken()
			response.resolve(jsonResponse({ ...TOKEN_RESPONSE, access_token: "stale-refresh" }))
			await new Promise((resolve) => setImmediate(resolve))
			release.resolve()
			await replacement
			expect(await refresh).toBeNull()
			expect(storedCredentials().access_token).toBe("access-token")
			expect(manager.getCredentials()).toEqual(storedCredentials())
		},
	)

	it("deletes a deferred refresh write before sign-out resolves", async () => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		const started = deferred<void>()
		const release = deferred<void>()
		const originalStore = secrets.store.getMockImplementation()!
		secrets.store.mockImplementationOnce(async (key, value) => {
			started.resolve()
			await release.promise
			await originalStore(key, value)
		})
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const refresh = manager.getAccessToken()
		await started.promise
		const signout = manager.clearCredentials()
		release.resolve()
		expect(await refresh).toBeNull()
		await signout
		expect(storedCredentials()).toBeNull()
		expect(manager.getCredentials()).toBeNull()
	})

	it.each([true, false])("clears only a confirmed invalid grant (invalid=%s)", async (invalid) => {
		const { manager, secrets, storedCredentials } = createManager()
		await manager.saveCredentials(oldCredentials)
		fetchMock.mockResolvedValueOnce(
			jsonResponse(
				{ error: invalid ? "invalid_grant" : "temporarily_unavailable" },
				{ ok: false, status: invalid ? 400 : 503 },
			),
		)
		expect(await manager.getAccessToken()).toBeNull()
		expect(secrets.delete).toHaveBeenCalledTimes(invalid ? 1 : 0)
		expect(storedCredentials()).toEqual(invalid ? null : oldCredentials)
	})

	it("does not resurrect credentials from a deferred load after sign-out", async () => {
		const { manager, secrets } = createManager()
		const response = deferred<string>()
		const started = deferred<void>()
		secrets.get.mockImplementationOnce(() => {
			started.resolve()
			return response.promise
		})
		const loading = manager.getAccessToken()
		await started.promise
		const signout = manager.clearCredentials()
		response.resolve(JSON.stringify(oldCredentials))
		expect(await loading).toBeNull()
		await signout
		expect(manager.getCredentials()).toBeNull()
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("allows deletion after a failed secret write", async () => {
		const { manager, secrets } = createManager()
		secrets.store.mockRejectedValueOnce(new Error("storage failure"))
		await expect(manager.saveCredentials(oldCredentials)).rejects.toThrow("storage failure")
		await manager.clearCredentials()
		expect(secrets.delete).toHaveBeenCalledTimes(1)
	})
})

describe("OAuth loopback listener", () => {
	let manager: OpenAiCodexOAuthManager
	let server: http.Server | undefined

	beforeEach(() => {
		nock.enableNetConnect("127.0.0.1:1455")
		fetchMock.mockReset()
		vi.stubGlobal("fetch", fetchMock)
		manager = createManager().manager
	})

	afterEach(async () => {
		const closed = server?.listening ? once(server, "close") : undefined
		manager.cancelAuthorizationFlow()
		await closed
		server = undefined
		nock.disableNetConnect()
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	const listen = async () => {
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())
		const waiting = manager.waitForCallback()
		// Observe cancellation immediately, including in tests which deliberately reject the waiter.
		void waiting.catch(() => undefined)
		server = (manager as unknown as { pendingAuth: { server: http.Server } }).pendingAuth.server
		await once(server, "listening")
		return { state, waiting }
	}

	const request = (path: string, method = "GET") =>
		new Promise<number | undefined>((resolve, reject) => {
			const address = server!.address() as AddressInfo
			const req = http.request(
				{ host: address.address, port: address.port, path, method, agent: false },
				(res) => {
					res.resume()
					res.on("end", () => resolve(res.statusCode))
				},
			)
			req.on("error", reject)
			req.end()
		})

	it("binds only to loopback and accepts a valid callback after invalid requests", async () => {
		const { state, waiting } = await listen()
		expect((server!.address() as AddressInfo).address).toBe("127.0.0.1")
		expect(await request("/favicon.ico")).toBe(404)
		expect(await request("/auth/callback")).toBe(400)
		expect(await request("/auth/callback?code=abc&state=wrong")).toBe(400)
		expect(await request("/auth/callback?error=access_denied")).toBe(400)
		expect(await request("/auth/callback?error=access_denied&state=wrong")).toBe(400)
		expect(await request(`/auth/callback?code=abc&state=${state}`, "POST")).toBe(405)
		expect(await request(`/auth/callback?code=abc&state=${state}&state=wrong`)).toBe(400)
		expect(await request(`/auth/callback?code=abc&error=denied&state=${state}`)).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		expect(await request(`/auth/callback?code=abc&state=${state}`)).toBe(200)
		await expect(waiting).resolves.toMatchObject({ access_token: "access-token" })
	})

	it("rejects the waiter for an OAuth error with the correct state", async () => {
		const { state, waiting } = await listen()
		const rejected = expect(waiting).rejects.toThrow("OAuth error: access_denied")
		expect(await request(`/auth/callback?error=access_denied&state=${state}`)).toBe(400)
		await rejected
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it("settles the real listener from a pasted callback", async () => {
		const { state, waiting } = await listen()
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		const credentials = await manager.submitCallbackUrl(callbackUrl(state))
		expect(await waiting).toEqual(credentials)
	})

	it.each(["isAuthenticated", "forceRefreshAccessToken"] as const)(
		"preserves a pending sign-in and its waiter when %s starts an invalid refresh",
		async (method) => {
			const fixture = createManager()
			manager = fixture.manager
			await manager.saveCredentials(oldCredentials)
			const { state, waiting } = await listen()
			const response = deferred<Response>()
			fetchMock.mockReturnValueOnce(response.promise)
			const refresh = manager[method]()
			const concurrent = manager.getAccessToken()
			expect(fetchMock).toHaveBeenCalledTimes(1)
			response.resolve(jsonResponse({ error: "invalid_grant" }, { ok: false }))
			expect(await refresh).toBe(method === "isAuthenticated" ? false : null)
			expect(await concurrent).toBeNull()
			expect(manager.getCredentials()).toBeNull()
			expect(fixture.storedCredentials()).toBeNull()
			expect(server!.listening).toBe(true)
			fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
			const credentials = await manager.submitCallbackUrl(callbackUrl(state))
			expect(await waiting).toEqual(credentials)
			expect(fixture.storedCredentials()).toEqual(credentials)
		},
	)

	it("keeps a valid flow available after a callback exchange failure", async () => {
		const { state, waiting } = await listen()
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant" }, { ok: false }))
		expect(await request(`/auth/callback?code=old&state=${state}`)).toBe(500)
		fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
		expect(await request(`/auth/callback?code=new&state=${state}`)).toBe(200)
		await expect(waiting).resolves.toMatchObject({ access_token: "access-token" })
	})

	it("invalidates a pending manual exchange when the listener times out", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const { state, waiting } = await listen()
		const response = deferred<Response>()
		fetchMock.mockReturnValueOnce(response.promise)
		const exchange = manager.submitCallbackUrl(callbackUrl(state))
		const rejectedExchange = expect(exchange).rejects.toThrow(/cancelled/)
		const rejectedWaiter = expect(waiting).rejects.toThrow(/timed out/)
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
		response.resolve(jsonResponse(TOKEN_RESPONSE))
		await rejectedWaiter
		await rejectedExchange
		expect(manager.getCredentials()).toBeNull()
	})

	it("shares repeated waiters and settles them when cancelled before the listener starts", async () => {
		manager.startAuthorizationFlow()
		const first = manager.waitForCallback()
		const second = manager.waitForCallback()
		server = (manager as unknown as { pendingAuth: { server: http.Server } }).pendingAuth.server
		const rejectedFirst = expect(first).rejects.toThrow(/cancelled/)
		const rejectedSecond = expect(second).rejects.toThrow(/cancelled/)
		manager.cancelAuthorizationFlow()
		await rejectedFirst
		await rejectedSecond
		await new Promise((resolve) => setImmediate(resolve))
		expect(server.listening).toBe(false)
	})

	it("allows a pasted callback when the callback port is occupied", async () => {
		const occupied = http.createServer()
		occupied.listen(1455, "127.0.0.1")
		await once(occupied, "listening")
		try {
			manager.startAuthorizationFlow()
			await expect(manager.waitForCallback()).rejects.toThrow(/already in use/)
			fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
			await expect(manager.submitCallbackUrl("manual-code")).resolves.toMatchObject({
				access_token: "access-token",
			})
		} finally {
			const closed = once(occupied, "close")
			occupied.close()
			await closed
		}
	})

	it.each(["signout", "cancel", "replacement"] as const)(
		"discards an in-flight socket exchange after %s",
		async (action) => {
			const { state, waiting } = await listen()
			const response = deferred<Response>()
			const started = deferred<void>()
			fetchMock.mockImplementationOnce(() => {
				started.resolve()
				return response.promise
			})
			const callback = request(`/auth/callback?code=abc&state=${state}`)
			await started.promise
			const rejected = expect(waiting).rejects.toThrow(/cancelled/)
			if (action === "signout") await manager.clearCredentials()
			else if (action === "cancel") manager.cancelAuthorizationFlow()
			else manager.startAuthorizationFlow()
			response.resolve(jsonResponse(TOKEN_RESPONSE))
			expect(await callback).toBe(500)
			await rejected
			expect(manager.getCredentials()).toBeNull()
			if (action === "replacement") {
				fetchMock.mockResolvedValueOnce(jsonResponse(TOKEN_RESPONSE))
				await expect(manager.submitCallbackUrl("new-code")).resolves.toMatchObject({
					access_token: "access-token",
				})
			}
		},
	)

	it("does not exchange the same flow twice while a socket callback is pending", async () => {
		const { state, waiting } = await listen()
		const response = deferred<Response>()
		const started = deferred<void>()
		fetchMock.mockImplementationOnce(() => {
			started.resolve()
			return response.promise
		})
		const callback = request(`/auth/callback?code=abc&state=${state}`)
		await started.promise
		expect(await request(`/auth/callback?code=abc&state=${state}`)).toBe(409)
		await expect(manager.submitCallbackUrl(callbackUrl(state))).rejects.toThrow(/already in progress/)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		response.resolve(jsonResponse(TOKEN_RESPONSE))
		expect(await callback).toBe(200)
		await waiting
	})
})

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
		const state = stateFromAuthUrl(manager.startAuthorizationFlow())

		// Stand in for waitForCallback() without binding the fixed port.
		;(manager as unknown as { pendingAuth: { settle: typeof settle } }).pendingAuth.settle = settle

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
