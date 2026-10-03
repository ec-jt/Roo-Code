import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	modelOperationSchema,
	modelOperationStatusSchema,
	type ModelOperation,
	type ModelOperationState,
} from "@roo-code/types"

import { safeWriteJson } from "../../../../utils/safeWriteJson"
import {
	ModelOperationCoordinator,
	type HistoricalModelOperationTask,
	type ModelOperationHost,
	type ModelOperationTask,
} from "../coordinator"
import { readRequestSnapshot, saveRequestSnapshot, type RequestSnapshot } from "../storage"

// Preserve real I/O while allowing targeted durability failures on the module wrapper.
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function makeTask(taskId: string) {
	const task = {
		taskId,
		instanceId: `${taskId}-instance`,
		cwd: path.resolve("workspace"),
		modelOperationState: {
			taskId,
			instanceId: `${taskId}-instance`,
			revision: 4,
			requestId: "request-1",
			readiness: "ready",
			requiresToolApproval: false,
		} as ModelOperationState,
		modelOperationDispatchClosed: false as boolean,
		parentTaskId: undefined as string | undefined,
		rootTaskId: undefined as string | undefined,
		childTaskId: undefined as string | undefined,
		pendingNewTaskToolCallId: undefined as string | undefined,
		isPaused: false as boolean,
		clineMessages: [] as RequestSnapshot["clineMessages"],
		apiConversationHistory: [] as RequestSnapshot["apiMessages"],
		getModelOperationEvidence: vi.fn(() => ({ toolsAdmitted: 0, toolsExecuted: 0 })),
		stopForModelOperation: vi.fn<ModelOperationTask["stopForModelOperation"]>(),
		prepareModelOperationPrefix: vi.fn<ModelOperationTask["prepareModelOperationPrefix"]>().mockResolvedValue(),
		startModelOperationPrefix: vi.fn<ModelOperationTask["startModelOperationPrefix"]>(),
		respondToModelOperationApproval: vi
			.fn<ModelOperationTask["respondToModelOperationApproval"]>()
			.mockReturnValue(false),
	} satisfies ModelOperationTask
	task.stopForModelOperation.mockImplementation(async (revision) => {
		expect(task.modelOperationState.revision).toBe(revision)
		task.modelOperationState.revision++
		task.modelOperationDispatchClosed = true
	})
	return task
}

type TaskDouble = ReturnType<typeof makeTask> & Partial<HistoricalModelOperationTask>

function addHistoricalHelpers(task: TaskDouble) {
	const helpers = {
		getHistoricalModelOperationBlockReason:
			vi.fn<HistoricalModelOperationTask["getHistoricalModelOperationBlockReason"]>(),
		stopForHistoricalModelOperation: vi
			.fn<HistoricalModelOperationTask["stopForHistoricalModelOperation"]>()
			.mockImplementation(async (revision) => {
				expect(task.modelOperationState.revision).toBe(revision)
				task.modelOperationState.revision++
				task.modelOperationDispatchClosed = true
			}),
	}
	Object.assign(task, helpers)
	return helpers
}

let root: string
let source: TaskDouble
let branch: TaskDouble
let current: TaskDouble | undefined
let snapshot: RequestSnapshot
let operation: ModelOperation
let host: ReturnType<typeof makeHost>
let coordinator: ModelOperationCoordinator<TaskDouble>

function makeHost() {
	return {
		getCurrentTask: vi.fn(() => current),
		getStorageRoot: vi.fn(async () => root),
		getWorkspacePath: vi.fn((): string | undefined => source.cwd),
		validateStandalone: vi.fn<ModelOperationHost<TaskDouble>["validateStandalone"]>().mockResolvedValue(),
		createBranch: vi.fn<ModelOperationHost<TaskDouble>["createBranch"]>().mockImplementation(async () => branch),
		activateBranch: vi
			.fn<ModelOperationHost<TaskDouble>["activateBranch"]>()
			.mockImplementation((previous, next) => {
				expect(current).toBe(previous)
				current = next
			}),
		discardBranch: vi.fn<ModelOperationHost<TaskDouble>["discardBranch"]>(),
		postStatus: vi.fn<ModelOperationHost<TaskDouble>["postStatus"]>().mockResolvedValue(undefined),
		postState: vi.fn<ModelOperationHost<TaskDouble>["postState"]>().mockResolvedValue(undefined),
	} satisfies ModelOperationHost<TaskDouble>
}

function receiptPath(operationId = operation.operationId) {
	const key = createHash("sha256").update(operationId).digest("hex")
	return path.join(root, "model-operation", "operations", `${key}.json`)
}

function expectNotActivated() {
	expect(host.activateBranch).not.toHaveBeenCalled()
	expect(branch.startModelOperationPrefix).not.toHaveBeenCalled()
}

function expectNotStopped() {
	expect(source.stopForModelOperation).not.toHaveBeenCalled()
	if (source.stopForHistoricalModelOperation) {
		expect(source.stopForHistoricalModelOperation).not.toHaveBeenCalled()
	}
	expectNotActivated()
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "model-operation-coordinator-"))
	source = makeTask("source-1")
	branch = makeTask("branch-1")
	current = source
	snapshot = {
		version: 1,
		taskId: source.taskId,
		requestId: "request-1",
		createdAt: 123,
		apiMessages: [{ role: "user", content: "Original question" }],
		clineMessages: [
			{ ts: 1, type: "say", say: "text", text: "Original question" },
			{ ts: 2, type: "say", say: "api_req_started", requestId: "request-1" },
		],
		systemPrompt: "Original system prompt",
		sourceProvider: "anthropic",
		sourceModelId: "source-model",
	}
	source.clineMessages = [
		...structuredClone(snapshot.clineMessages),
		{ ts: 3, type: "say", say: "text", text: "Completed answer", requestId: snapshot.requestId },
	]
	source.apiConversationHistory = [
		...structuredClone(snapshot.apiMessages),
		{ role: "assistant", content: "Completed answer", requestId: snapshot.requestId },
	]
	operation = {
		operationId: "operation-1",
		kind: "switch",
		taskId: source.taskId,
		instanceId: source.instanceId,
		revision: source.modelOperationState.revision,
		profileId: "saved-target-profile",
		requestId: snapshot.requestId,
		confirmCurrentWorkspace: true,
	}
	host = makeHost()
	coordinator = new ModelOperationCoordinator(host)
	await saveRequestSnapshot(root, snapshot)
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

describe("ModelOperationCoordinator host contract", () => {
	it.each(["model-operation", "."])(
		"requires durable receipt ancestor %s before stopping the source",
		async (ancestor) => {
			if (process.platform === "win32") return
			const open = fs.open
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				if (String(args[0]) === path.resolve(root, ancestor)) throw new Error("Injected ancestor sync failure")
				return open(...args)
			})
			const result = await coordinator.run(operation)
			expect(result.status).toBe("failed")
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
			openSpy.mockRestore()
			const reopened = new ModelOperationCoordinator(host)
			expect((await reopened.run(operation)).status).not.toBe("completed")
			expectNotStopped()
		},
	)

	it("prepares a fresh live branch from its durable snapshot before stopping and activating", async () => {
		const events: string[] = []
		host.createBranch.mockImplementation(async (task, saved, profile) => {
			expect(task).toBe(source)
			expect(saved).toEqual(snapshot)
			expect(saved).not.toBe(snapshot)
			expect(profile).toBe(operation.profileId)
			expect(current).toBe(source)
			events.push("create")
			return branch
		})
		branch.prepareModelOperationPrefix.mockImplementation(async () => {
			expectNotStopped()
			events.push("prepare")
		})
		source.stopForModelOperation.mockImplementation(async (revision) => {
			expect(revision).toBe(operation.revision)
			expect(current).toBe(source)
			events.push("stop")
			source.modelOperationState.revision++
			source.modelOperationDispatchClosed = true
		})
		host.activateBranch.mockImplementation((previous, next) => {
			expect(previous).toBe(source)
			expect(next).toBe(branch)
			expect(previous.modelOperationDispatchClosed).toBe(true)
			current = next
			events.push("activate")
		})
		branch.startModelOperationPrefix.mockImplementation(() => {
			events.push("start")
		})

		const status = await coordinator.run(operation)

		expect(status).toMatchObject({
			operationId: operation.operationId,
			status: "completed",
			taskId: branch.taskId,
			instanceId: branch.instanceId,
			revision: branch.modelOperationState.revision,
		})
		expect(status.message).toContain("not yet complete")
		expect(events).toEqual(["create", "prepare", "stop", "activate", "start"])
		expect(branch.prepareModelOperationPrefix).toHaveBeenCalledExactlyOnceWith(snapshot, operation.profileId, {
			version: 1,
			operationId: operation.operationId,
			kind: "switch",
			sourceTaskId: source.taskId,
			sourceRequestId: snapshot.requestId,
			targetProfileId: operation.profileId,
			workspacePath: source.cwd,
			requiresToolApproval: true,
			createdAt: expect.any(Number),
		})
		expect(host.validateStandalone).toHaveBeenCalledTimes(2)
		expect(host.discardBranch).not.toHaveBeenCalled()
		expect(current).toBe(branch)
		expect(host.postStatus.mock.calls.map(([value]) => value.status)).toEqual(["running", "completed"])
		expect(JSON.parse(await fs.readFile(receiptPath(), "utf8")).status).toEqual(status)
	})

	it.each(["switch", "regenerate"] as const)(
		"leaves source UI/API histories and saved snapshot untouched for %s",
		async (kind) => {
			if (kind === "regenerate") addHistoricalHelpers(source)
			const apiBefore = structuredClone(source.apiConversationHistory)
			const uiBefore = structuredClone(source.clineMessages)
			const apiReference = source.apiConversationHistory
			const uiReference = source.clineMessages
			const directory = path.join(root, "tasks", source.taskId)
			const files = [
				path.join(directory, "api_conversation_history.json"),
				path.join(directory, "ui_messages.json"),
			]
			await safeWriteJson(files[0], apiBefore)
			await safeWriteJson(files[1], uiBefore)
			const bytes = await Promise.all(files.map((file) => fs.readFile(file, "utf8")))

			expect((await coordinator.run({ ...operation, kind })).status).toBe("completed")

			expect(source.apiConversationHistory).toBe(apiReference)
			expect(source.clineMessages).toBe(uiReference)
			expect(source.apiConversationHistory).toEqual(apiBefore)
			expect(source.clineMessages).toEqual(uiBefore)
			expect(await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).toEqual(bytes)
			expect(await readRequestSnapshot(root, source.taskId, snapshot.requestId)).toEqual(snapshot)
		},
	)

	it("blocks current-response tools live but allows quiescent historical regeneration through optional fences", async () => {
		const helpers = addHistoricalHelpers(source)
		source.getModelOperationEvidence.mockReturnValue({ toolsAdmitted: 1, toolsExecuted: 1 })
		source.modelOperationState.readiness = "blocked"
		source.modelOperationState.reason = "Prior tools executed"
		const saved: RequestSnapshot = {
			...snapshot,
			requestId: "request-with-tools",
			apiMessages: [
				{ role: "user", content: "Read a file" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "example.txt" } }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Saved file contents" }],
				},
			],
		}
		await saveRequestSnapshot(root, saved)
		source.clineMessages.push({ ts: 4, type: "say", say: "text", text: "File summary", requestId: saved.requestId })
		source.apiConversationHistory.push({ role: "assistant", content: "File summary", requestId: saved.requestId })

		expect(await coordinator.run(operation)).toMatchObject({
			status: "blocked",
			message: expect.stringContaining("Tools"),
		})
		expectNotStopped()
		const historical = { ...operation, operationId: "historical-1", kind: "regenerate", requestId: saved.requestId }
		expect((await coordinator.run(historical)).status).toBe("completed")
		expect(helpers.getHistoricalModelOperationBlockReason).toHaveBeenCalledTimes(2)
		expect(helpers.stopForHistoricalModelOperation).toHaveBeenCalledExactlyOnceWith(operation.revision)
		expect(source.stopForModelOperation).not.toHaveBeenCalled()
		expect(host.createBranch).toHaveBeenCalledExactlyOnceWith(source, saved, operation.profileId)
		expect(branch.prepareModelOperationPrefix).toHaveBeenCalledWith(
			saved,
			operation.profileId,
			expect.objectContaining({
				kind: "regenerate",
				sourceRequestId: saved.requestId,
				requiresToolApproval: true,
			}),
		)
	})

	it("switches the next request with completed mixed-provider tools without changing source or repeating activation", async () => {
		const saved: RequestSnapshot = {
			...snapshot,
			requestId: "settled-request",
			apiMessages: [
				{ role: "user", content: "Read both files, then explain" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Reading files" },
						{ type: "tool_use", id: "call_openai_1", name: "read_file", input: { path: "a.txt" } },
						{ type: "tool_use", id: "toolu_anthropic_2", name: "read_file", input: { path: "b.txt" } },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_anthropic_2",
							content: "Missing file",
							is_error: true,
						},
						{ type: "tool_result", tool_use_id: "call_openai_1", content: "Persisted contents" },
						{ type: "text", text: "Explain the available evidence" },
					],
				},
			],
		}
		await saveRequestSnapshot(root, saved)
		source.modelOperationState.requestId = saved.requestId
		source.apiConversationHistory = [
			...structuredClone(saved.apiMessages),
			{ role: "assistant", content: "Partial" },
		]
		const before = structuredClone(source.apiConversationHistory)
		const request = { ...operation, requestId: saved.requestId }
		const result = await coordinator.run(request)
		expect(result.status).toBe("completed")
		expect(branch.prepareModelOperationPrefix).toHaveBeenCalledWith(saved, operation.profileId, expect.any(Object))
		expect(source.apiConversationHistory).toEqual(before)
		expect(await readRequestSnapshot(root, source.taskId, saved.requestId)).toEqual(saved)
		expect(await coordinator.run(request)).toEqual(result)
		expect(branch.startModelOperationPrefix).toHaveBeenCalledTimes(1)
		expect(source.stopForModelOperation).toHaveBeenCalledTimes(1)
	})

	it.each(["incomplete", "orphan", "duplicate call", "duplicate result"])(
		"rejects %s tool history before branch creation even when live state claims readiness",
		async (invalid) => {
			const call = { type: "tool_use" as const, id: "call", name: "read_file", input: {} }
			const result = { type: "tool_result" as const, tool_use_id: "call", content: "Saved" }
			const saved: RequestSnapshot = {
				...snapshot,
				requestId: "invalid-pairs",
				apiMessages: [
					{ role: "user", content: "Read" },
					{ role: "assistant", content: invalid === "duplicate call" ? [call, call] : [call] },
					{
						role: "user",
						content:
							invalid === "incomplete"
								? []
								: invalid === "duplicate result"
									? [result, result]
									: [{ ...result, tool_use_id: invalid === "orphan" ? "unknown" : "call" }],
					},
				],
			}
			await saveRequestSnapshot(root, saved)
			source.modelOperationState.requestId = saved.requestId
			expect(await coordinator.run({ ...operation, requestId: saved.requestId })).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("incomplete tool pairs"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it.each(["both", "reason", "stop"])(
		"blocks historical regeneration when %s helpers are unavailable",
		async (missing) => {
			addHistoricalHelpers(source)
			if (missing !== "stop") delete source.getHistoricalModelOperationBlockReason
			if (missing !== "reason") delete source.stopForHistoricalModelOperation
			expect(await coordinator.run({ ...operation, kind: "regenerate" })).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("historical-quiescence fence"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it.each(["before", "after"])("honors historical quiescence failures %s preparation", async (phase) => {
		const helpers = addHistoricalHelpers(source)
		if (phase === "after") helpers.getHistoricalModelOperationBlockReason.mockReturnValueOnce(undefined)
		helpers.getHistoricalModelOperationBlockReason.mockReturnValue("Historical tool execution is still active")
		expect(await coordinator.run({ ...operation, kind: "regenerate" })).toMatchObject({
			status: "blocked",
			message: "Historical tool execution is still active",
		})
		expectNotStopped()
		if (phase === "after") expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
		else expect(host.createBranch).not.toHaveBeenCalled()
	})

	it.each([
		"missing request",
		"untagged UI",
		"partial",
		"empty",
		"synthetic",
		"ask",
		"missing assistant",
		"different assistant",
	])("requires a genuine completed assistant request ID: %s", async (invalid) => {
		addHistoricalHelpers(source)
		const row = source.clineMessages.at(-1)!
		const request = { ...operation, kind: "regenerate" as const }
		if (invalid === "missing request") delete request.requestId
		if (invalid === "untagged UI") delete row.requestId
		if (invalid === "partial") row.partial = true
		if (invalid === "empty") row.text = ""
		if (invalid === "synthetic") row.say = "api_req_started"
		if (invalid === "ask") {
			row.type = "ask"
			row.ask = "followup"
		}
		if (invalid === "missing assistant")
			source.apiConversationHistory = [
				{ role: "user", content: "Not an assistant", requestId: snapshot.requestId },
			]
		if (invalid === "different assistant") source.apiConversationHistory.at(-1)!.requestId = "other-request"
		expect(await coordinator.run(request)).toMatchObject({
			status: "blocked",
			message: expect.stringContaining("genuine completed assistant"),
		})
		expect(host.createBranch).not.toHaveBeenCalled()
		expectNotStopped()
	})

	it.each(["taskId", "instanceId", "revision"] as const)(
		"rejects stale %s before preparing a branch",
		async (field) => {
			const request = { ...operation, [field]: field === "revision" ? 99 : "stale-identity" }
			expect(await coordinator.run(request)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("Stale"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it.each([
		["create", "identity"],
		["create", "revision"],
		["prepare", "identity"],
		["prepare", "revision"],
	] as const)("rejects changed %s-await %s and discards the unactivated branch", async (phase, change) => {
		const entered = deferred()
		const release = deferred()
		const wait = async () => {
			entered.resolve()
			await release.promise
		}
		if (phase === "create")
			host.createBranch.mockImplementation(async () => {
				await wait()
				return branch
			})
		else branch.prepareModelOperationPrefix.mockImplementation(wait)
		const pending = coordinator.run(operation)
		await entered.promise
		try {
			expectNotStopped()
			if (change === "identity") current = { ...source }
			else source.modelOperationState.revision++
		} finally {
			release.resolve()
		}
		expect(await pending).toMatchObject({ status: "blocked", message: expect.stringContaining("Stale") })
		expectNotStopped()
		expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
		if (phase === "create") expect(branch.prepareModelOperationPrefix).not.toHaveBeenCalled()
	})

	it.each([1, 2])("rechecks identity after standalone validation number %s", async (validation) => {
		let calls = 0
		host.validateStandalone.mockImplementation(async () => {
			if (++calls === validation) source.modelOperationState.revision++
		})
		expect(await coordinator.run(operation)).toMatchObject({
			status: "blocked",
			message: expect.stringContaining("Stale"),
		})
		expectNotStopped()
		if (validation === 2) expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
		else expect(host.createBranch).not.toHaveBeenCalled()
	})

	it("requires explicit current-workspace confirmation", async () => {
		expect(await coordinator.run({ ...operation, confirmCurrentWorkspace: false })).toMatchObject({
			status: "blocked",
			message: expect.stringContaining("Confirm use of the current workspace"),
		})
		expect(host.validateStandalone).not.toHaveBeenCalled()
		expect(host.createBranch).not.toHaveBeenCalled()
		expectNotStopped()
	})

	it.each(["switch", "regenerate"] as const)(
		"blocks %s without a durable snapshot instead of reconstructing history",
		async (kind) => {
			addHistoricalHelpers(source)
			await fs.rm(
				path.join(root, "tasks", source.taskId, "model-operation", `request-${snapshot.requestId}.json`),
			)
			expect(await coordinator.run({ ...operation, kind })).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("No durable snapshot"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it.each([
		{ toolsAdmitted: 1, toolsExecuted: 0 },
		{ toolsAdmitted: 0, toolsExecuted: 1 },
	])("blocks live switching with tool evidence %j", async (evidence) => {
		source.getModelOperationEvidence.mockReturnValue(evidence)
		expect(await coordinator.run(operation)).toMatchObject({
			status: "blocked",
			message: expect.stringContaining("Tools have been admitted or executed"),
		})
		expect(host.createBranch).not.toHaveBeenCalled()
		expectNotStopped()
	})

	it.each(["switch", "regenerate"] as const)("does not activate when the %s source stop fails", async (kind) => {
		const helpers = addHistoricalHelpers(source)
		const stop = kind === "switch" ? source.stopForModelOperation : helpers.stopForHistoricalModelOperation
		stop.mockRejectedValue(new Error("stop failed: secret-provider-key"))
		const status = await coordinator.run({ ...operation, kind })
		expect(status.status).toBe("failed")
		expect(status.message).not.toContain("secret-provider-key")
		expect(stop).toHaveBeenCalledExactlyOnceWith(operation.revision)
		expectNotActivated()
		expect(current).toBe(source)
		expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
	})

	it.each(["revision", "dispatch", "identity"])(
		"requires a closed, revision-fenced source after stop: %s",
		async (failure) => {
			source.stopForModelOperation.mockImplementation(async () => {
				if (failure !== "revision") source.modelOperationState.revision++
				if (failure !== "dispatch") source.modelOperationDispatchClosed = true
				if (failure === "identity") current = { ...source }
			})
			expect(await coordinator.run(operation)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining(failure === "dispatch" ? "Source dispatch did not close" : "Stale"),
			})
			expectNotActivated()
			expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
		},
	)

	it.each(["parentTaskId", "rootTaskId", "childTaskId", "pendingNewTaskToolCallId", "isPaused"] as const)(
		"rejects non-standalone source state %s",
		async (field) => {
			if (field === "isPaused") source.isPaused = true
			else source[field] = "linked-task"
			expect(await coordinator.run(operation)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("Task graph operations"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it.each([1, 2])("honors persisted standalone rejection at validation %s", async (validation) => {
		if (validation === 2) host.validateStandalone.mockResolvedValueOnce()
		host.validateStandalone.mockRejectedValue(new Error("Persisted delegated task"))
		expect((await coordinator.run(operation)).status).toBe("failed")
		expectNotStopped()
		if (validation === 2) expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
		else expect(host.createBranch).not.toHaveBeenCalled()
	})

	it.each([undefined, path.resolve("other-workspace")])(
		"blocks missing or mismatched workspace %s",
		async (workspace) => {
			host.getWorkspacePath.mockReturnValue(workspace)
			expect(await coordinator.run(operation)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("workspace differs"),
			})
			expect(host.createBranch).not.toHaveBeenCalled()
			expectNotStopped()
		},
	)

	it("fails saved-profile lookup before stopping the source", async () => {
		host.createBranch.mockRejectedValue(new Error("Saved profile unavailable: credential=secret"))
		const status = await coordinator.run(operation)
		expect(status.status).toBe("failed")
		expect(status.message).not.toContain("credential")
		expect(host.createBranch).toHaveBeenCalledExactlyOnceWith(source, snapshot, operation.profileId)
		expectNotStopped()
		expect(branch.prepareModelOperationPrefix).not.toHaveBeenCalled()
		expect(host.discardBranch).not.toHaveBeenCalled()
		expect(current).toBe(source)
	})

	it("discards a branch whose preparation fails before stopping the source", async () => {
		branch.prepareModelOperationPrefix.mockRejectedValue(new Error("Could not save branch prefix"))
		expect((await coordinator.run(operation)).status).toBe("failed")
		expectNotStopped()
		expect(host.discardBranch).toHaveBeenCalledExactlyOnceWith(branch)
	})
})

describe("durable operation receipts and serialization", () => {
	it.each(["completed", "blocked", "failed"] as const)(
		"returns the exact prior %s status in this and a new coordinator",
		async (outcome) => {
			if (outcome === "blocked") operation.confirmCurrentWorkspace = false
			if (outcome === "failed") host.createBranch.mockRejectedValue(new Error("Unavailable saved profile"))
			const first = await coordinator.run(operation)
			expect(first.status).toBe(outcome)
			const bytes = await fs.readFile(receiptPath(), "utf8")
			const count = host.createBranch.mock.calls.length
			current = undefined
			expect(await coordinator.run({ ...operation })).toEqual(first)
			const restartedHost = makeHost()
			expect(await new ModelOperationCoordinator(restartedHost).run({ ...operation })).toEqual(first)
			expect(restartedHost.getCurrentTask).not.toHaveBeenCalled()
			expect(restartedHost.createBranch).not.toHaveBeenCalled()
			expect(restartedHost.postStatus).toHaveBeenCalledExactlyOnceWith(first)
			expect(host.createBranch).toHaveBeenCalledTimes(count)
			expect(await fs.readFile(receiptPath(), "utf8")).toBe(bytes)
		},
	)

	it.each([false, true])(
		"blocks operation-ID collisions without replacing the receipt (new coordinator: %s)",
		async (restart) => {
			const first = await coordinator.run(operation)
			const bytes = await fs.readFile(receiptPath(), "utf8")
			const runner = restart ? new ModelOperationCoordinator(host) : coordinator
			expect(await runner.run({ ...operation, profileId: "different-profile" })).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("collision"),
			})
			expect(host.createBranch).toHaveBeenCalledTimes(1)
			expect(await fs.readFile(receiptPath(), "utf8")).toBe(bytes)
			expect(await runner.run(operation)).toEqual(first)
		},
	)

	it("blocks an interrupted durable running receipt instead of replaying it", async () => {
		await safeWriteJson(receiptPath(), {
			version: 1,
			fingerprint: createHash("sha256")
				.update(JSON.stringify(modelOperationSchema.parse(operation)))
				.digest("hex"),
			status: {
				operationId: operation.operationId,
				status: "running",
				message: "Process stopped during preparation",
			},
		})
		const bytes = await fs.readFile(receiptPath(), "utf8")
		for (const runner of [coordinator, new ModelOperationCoordinator(host)]) {
			expect(await runner.run(operation)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("interrupted"),
			})
		}
		expect(host.createBranch).not.toHaveBeenCalled()
		expectNotStopped()
		expect(await fs.readFile(receiptPath(), "utf8")).toBe(bytes)
	})

	it("excludes another coordinator while the same durable receipt is running", async () => {
		const entered = deferred()
		const release = deferred()
		branch.prepareModelOperationPrefix.mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		const first = coordinator.run(operation)
		await entered.promise
		try {
			expect(JSON.parse(await fs.readFile(receiptPath(), "utf8")).status.status).toBe("running")
			expect(await new ModelOperationCoordinator(host).run(operation)).toMatchObject({
				status: "blocked",
				message: expect.stringContaining("running"),
			})
			expect(host.createBranch).toHaveBeenCalledTimes(1)
			expectNotStopped()
		} finally {
			release.resolve()
		}
		expect((await first).status).toBe("completed")
	})

	it("serializes competing operations so the second cannot prepare against the replaced source", async () => {
		const entered = deferred()
		const release = deferred()
		branch.prepareModelOperationPrefix.mockImplementation(async () => {
			entered.resolve()
			await release.promise
		})
		const first = coordinator.run(operation)
		await entered.promise
		const second = coordinator.run({ ...operation, operationId: "competing-operation" })
		try {
			await Promise.resolve()
			expect(host.getStorageRoot).toHaveBeenCalledTimes(1)
			expect(host.createBranch).toHaveBeenCalledTimes(1)
			expectNotStopped()
		} finally {
			release.resolve()
		}
		const statuses = await Promise.all([first, second])
		expect(statuses[0].status).toBe("completed")
		expect(statuses[1]).toMatchObject({ status: "blocked", message: expect.stringContaining("Stale") })
		expect(host.createBranch).toHaveBeenCalledTimes(1)
		expect(host.activateBranch).toHaveBeenCalledTimes(1)
		expect(branch.startModelOperationPrefix).toHaveBeenCalledTimes(1)
		expect(JSON.parse(await fs.readFile(receiptPath("competing-operation"), "utf8")).status).toEqual(statuses[1])
	})
})

describe("approval status responses", () => {
	it.each(["operationId", "approvalId"] as const)("returns schema-valid diagnostics for blank %s", async (field) => {
		const payload = { [field]: " \t\n" }
		const status =
			field === "operationId" ? await coordinator.run(payload) : await coordinator.respondToApproval(payload)
		expect(status.status).toBe("blocked")
		expect(modelOperationStatusSchema.safeParse(status).success).toBe(true)
		expect(source.respondToModelOperationApproval).not.toHaveBeenCalled()
		expectNotStopped()
	})

	it("reports invalid approval explicitly using approvalId, not operationId", async () => {
		const status = await coordinator.respondToApproval({
			approvalId: "approval-invalid",
			operationId: "not-the-approval-id",
			approved: true,
		})
		expect(status).toMatchObject({
			operationId: "approval-invalid",
			status: "blocked",
			message: expect.stringContaining("Invalid or stale"),
		})
		expect(source.respondToModelOperationApproval).not.toHaveBeenCalled()
		expect(host.postStatus).toHaveBeenCalledExactlyOnceWith(status)
		expect(host.postState).toHaveBeenCalledTimes(1)
		expectNotStopped()
	})

	it.each([false, true])("publishes the host approval result (accepted: %s)", async (accepted) => {
		const approval = {
			taskId: source.taskId,
			instanceId: source.instanceId,
			revision: operation.revision,
			approvalId: "approval-1",
			approved: true,
		}
		source.respondToModelOperationApproval.mockReturnValue(accepted)
		const status = await coordinator.respondToApproval(approval)
		expect(status).toMatchObject({
			operationId: approval.approvalId,
			status: accepted ? "completed" : "blocked",
			taskId: source.taskId,
			instanceId: source.instanceId,
			revision: operation.revision,
		})
		expect(source.respondToModelOperationApproval).toHaveBeenCalledExactlyOnceWith(approval)
		expect(host.postStatus).toHaveBeenCalledExactlyOnceWith(status)
		expect(host.postState).toHaveBeenCalledTimes(1)
		expect(host.createBranch).not.toHaveBeenCalled()
	})
})

describe("late safety fences", () => {
	it("blocks tools admitted while the branch is being prepared", async () => {
		branch.prepareModelOperationPrefix.mockImplementation(async () => {
			source.getModelOperationEvidence.mockReturnValue({ toolsAdmitted: 1, toolsExecuted: 0 })
		})
		const status = await coordinator.run(operation)
		expect(status).toMatchObject({ status: "blocked", message: expect.stringContaining("Tools were admitted") })
		expect(source.stopForModelOperation).not.toHaveBeenCalled()
		expect(host.activateBranch).not.toHaveBeenCalled()
		expect(host.discardBranch).toHaveBeenCalledWith(branch)
	})

	it("blocks changed readiness before the source stop", async () => {
		branch.prepareModelOperationPrefix.mockImplementation(async () => {
			source.modelOperationState.readiness = "blocked"
			source.modelOperationState.reason = "Wait for the active presenter or edit to finish."
		})
		const status = await coordinator.run(operation)
		expect(status).toMatchObject({ status: "blocked", message: expect.stringContaining("presenter") })
		expect(source.stopForModelOperation).not.toHaveBeenCalled()
		expect(host.activateBranch).not.toHaveBeenCalled()
	})

	it("rejects receipt identity mismatch even when the fingerprint matches", async () => {
		await coordinator.run(operation)
		const file = receiptPath()
		const receipt = JSON.parse(await fs.readFile(file, "utf8"))
		receipt.status.operationId = "different-operation"
		await safeWriteJson(file, receipt)
		const reopened = new ModelOperationCoordinator(host)
		const status = await reopened.run(operation)
		expect(status).toMatchObject({ status: "blocked", message: expect.stringContaining("collision") })
		expect(host.createBranch).toHaveBeenCalledTimes(1)
	})
})
