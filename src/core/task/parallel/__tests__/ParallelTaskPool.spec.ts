// npx vitest run core/task/parallel/__tests__/ParallelTaskPool.spec.ts
//
// Integration tests: real Task loops, real git worktrees in temporary repositories, fake model handlers.

import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { RooCodeEventName } from "@roo-code/types"

import { Task } from "../../Task"
import { buildApiHandler } from "../../../../api"
import { OpenAiHandler } from "../../../../api/providers/openai"
import { BatchAdmissionRuntime } from "../BatchAdmissionRuntime"
import { PARALLEL_REFUSAL_MESSAGE } from "../non-interactive"
import { ParallelTaskPool, formatParallelBatchResult } from "../ParallelTaskPool"

const paths = vi.hoisted(() => ({ storage: "" }))
const openAiCreate = vi.hoisted(() => vi.fn())

vi.mock("vscode", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	const languages = { ...actual.languages, getDiagnostics: () => [] }
	const window = { ...actual.window, tabGroups: { all: [] }, showTextDocument: async () => undefined }
	const workspace = {
		...actual.workspace,
		isTrusted: false,
		openTextDocument: async () => ({ isDirty: false, save: async () => true }),
	}
	class TabInputTextDiff {}
	class RelativePattern {}
	return {
		...actual,
		languages,
		window,
		workspace,
		TabInputTextDiff,
		RelativePattern,
		default: { ...actual.default, languages, window, workspace, TabInputTextDiff, RelativePattern },
	}
})
vi.mock("openai", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	const OpenAI = vi.fn(() => ({ chat: { completions: { create: openAiCreate } } }))
	return { ...actual, default: OpenAI, OpenAI }
})
vi.mock("../../../webview/ClineProvider")
vi.mock("../../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: vi.fn(() => ({
		initialize: async () => {},
		validateAccess: () => true,
		getInstructions: () => undefined,
		dispose: () => {},
	})),
}))
vi.mock("../../../protect/RooProtectedController", () => ({
	RooProtectedController: vi.fn(() => ({ isWriteProtected: () => false })),
}))
vi.mock("../../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: vi.fn(() => ({
		trackFileContext: async () => {},
		getFilesReadByRoo: async () => [],
		dispose: () => {},
	})),
}))
vi.mock("../../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: { getTerminals: vi.fn(() => []), releaseTerminalsForTask: vi.fn() },
}))
vi.mock("../../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async () => paths.storage),
	getTaskDirectoryPath: vi.fn(async (_base: string, id: string) => path.join(paths.storage, "tasks", id)),
}))
vi.mock("../../model-operation/storage", () => ({
	saveRequestSnapshot: vi.fn(async () => {}),
	saveBranchReplay: vi.fn(),
	readBranchProvenance: vi.fn(async () => undefined),
	readBranchReplaySnapshot: vi.fn(),
}))
vi.mock("../../../task-persistence", () => ({
	flushTaskSaves: vi.fn(async () => {}),
	saveApiMessages: vi.fn(async () => {}),
	saveTaskMessages: vi.fn(async () => {}),
	readApiMessages: vi.fn(async () => []),
	readTaskMessages: vi.fn(async () => []),
	taskMetadata: vi.fn(async (options: any) => ({
		historyItem: {
			id: options.taskId,
			parentTaskId: options.parentTaskId,
			rootTaskId: options.rootTaskId,
			number: 1,
			ts: Date.now(),
			task: "child",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			mode: options.mode,
		},
		tokenUsage: {},
	})),
}))
vi.mock("../../../../api", () => ({ buildApiHandler: vi.fn() }))
vi.mock("../../build-tools", () => ({ buildNativeToolsArrayWithRestrictions: vi.fn(async () => ({ tools: [] })) }))
vi.mock("../../../checkpoints", () => ({ getCheckpointService: vi.fn(), checkpointSave: vi.fn() }))
vi.mock("../../../environment/getEnvironmentDetails", () => ({ getEnvironmentDetails: vi.fn(async () => "env") }))
vi.mock("../../../mentions/processUserContentMentions", () => ({
	processUserContentMentions: vi.fn(async ({ userContent }: any) => ({ content: userContent })),
}))

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

interface RequestRecord {
	key: string
	step: number
	start: number
	end?: number
}

type Step = { name: string; args: Record<string, unknown> }

const SCRIPTS: Record<string, Step[]> = {
	write: [{ name: "write_to_file", args: { path: "a.txt", content: "hello\n" } }],
	write2: [{ name: "write_to_file", args: { path: "b.txt", content: "world\n" } }],
	ask: [
		{
			name: "ask_followup_question",
			args: { question: "Which file?", follow_up: [{ text: "a.txt", mode: null }] },
		},
		{ name: "switch_mode", args: { mode_slug: "architect", reason: "plan" } },
	],
	plain: [],
}

/** Fake handler: one scripted tool call per request, then attempt_completion. Records request intervals. */
function fakeHandler(requests: RequestRecord[], options: { delayMs?: number; hang?: boolean } = {}) {
	return {
		getModel: () => ({
			id: "fake-model",
			info: { contextWindow: 200_000, maxTokens: 1_000, supportsPromptCache: false },
		}),
		countTokens: async () => 0,
		createMessage: (_system: string, messages: any[]) =>
			(async function* () {
				const key = /\[script:(\w+)\]/.exec(JSON.stringify(messages[0]))?.[1] ?? "plain"
				const step = messages.filter((m) => m.role === "assistant").length
				const record: RequestRecord = { key, step, start: performance.now() }
				requests.push(record)
				if (options.hang) await new Promise(() => {})
				await new Promise((r) => setTimeout(r, options.delayMs ?? 60))
				const script = SCRIPTS[key] ?? []
				const next = script[step] ?? { name: "attempt_completion", args: { result: `done ${key}` } }
				yield {
					type: "tool_call" as const,
					id: `call_${key}_${step}_${Math.random().toString(36).slice(2, 8)}`,
					name: next.name,
					arguments: JSON.stringify(next.args),
				}
				yield { type: "usage" as const, inputTokens: 10, outputTokens: 5 }
				record.end = performance.now()
			})(),
	}
}

let root: string
let repo: string
let state: Record<string, any>
let settings: Record<string, any>
let provider: any
let parent: Task
let requests: RequestRecord[]
const createdTasks: Task[] = []

function makeProvider() {
	const stack: Task[] = []
	const history: Array<{ item: any; options: any }> = []
	return {
		stack,
		history,
		context: { globalStorageUri: { fsPath: paths.storage }, extensionUri: { fsPath: paths.storage } },
		contextProxy: {
			getValue: (key: string) => settings[key],
			extensionMode: 1,
		},
		getState: vi.fn(async () => ({ ...state })),
		postStateToWebview: vi.fn(async () => {}),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		postStateToWebviewWithoutClineMessages: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		updateTaskHistory: vi.fn(async (item: any, options: any) => {
			history.push({ item, options })
			return []
		}),
		getTaskWithId: vi.fn(async (id: string) => ({ historyItem: { id } })),
		addClineToStack: vi.fn(),
		getCurrentTask: () => stack.at(-1),
		getMcpHub: () => undefined,
		getSkillsManager: () => undefined,
		log: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

async function readStop(taskId: string): Promise<string | undefined> {
	const file = path.join(paths.storage, "tasks", taskId, "evaluation.json")
	for (let i = 0; i < 50; i++) {
		try {
			const record = JSON.parse(fs.readFileSync(file, "utf8"))
			if (record.stop) return record.stop.reason
		} catch {
			// not yet written
		}
		await new Promise((r) => setTimeout(r, 20))
	}
	return undefined
}

const overlaps = (a: RequestRecord, b: RequestRecord) => a.start < b.end! && b.start < a.end!

beforeEach(() => {
	const tmp = fs.realpathSync(os.tmpdir())
	root = fs.mkdtempSync(path.join(tmp, "roo-parallel-"))
	repo = path.join(root, "repo")
	paths.storage = path.join(root, "storage")
	fs.mkdirSync(repo)
	fs.mkdirSync(paths.storage)
	git(repo, "init", "-q", "-b", "main")
	git(repo, "config", "user.email", "test@example.com")
	git(repo, "config", "user.name", "Test")
	git(repo, "config", "commit.gpgsign", "false")
	fs.writeFileSync(path.join(repo, "README.md"), "base\n")
	git(repo, "add", ".")
	git(repo, "commit", "-q", "-m", "base")

	requests = []
	settings = { taskProfile: "modes", experiments: { evaluationRecording: true } }
	state = {
		mode: "code",
		customModes: [],
		mcpEnabled: false,
		diagnosticsEnabled: false,
		autoApprovalEnabled: false,
		alwaysAllowWrite: false,
		experiments: { evaluationRecording: true },
		apiConfiguration: { apiProvider: "openai" },
	}
	vi.mocked(buildApiHandler).mockImplementation(() => fakeHandler(requests) as any)
	vi.spyOn(Task.prototype as any, "getSystemPrompt").mockResolvedValue("system")
	provider = makeProvider()
	parent = new Task({
		provider,
		apiConfiguration: { apiProvider: "openai", openAiModelId: "fake-model" },
		task: "parent",
		startTask: false,
		workspacePath: repo,
		enableCheckpoints: false,
	})
	createdTasks.push(parent)
	provider.stack.push(parent)
})

afterEach(async () => {
	for (const task of createdTasks.splice(0)) await task.dispose({ preserveArtifacts: true }).catch(() => {})
	vi.restoreAllMocks()
	try {
		git(repo, "worktree", "prune")
	} catch {
		// ignore
	}
	fs.rmSync(root, { recursive: true, force: true })
})

describe("ParallelTaskPool", () => {
	it("runs two children at the same time in separate worktrees and leaves the parent tree unchanged", async () => {
		state.autoApprovalEnabled = true
		state.alwaysAllowWrite = true
		const parentHead = git(repo, "rev-parse", "HEAD").trim()
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({
			parent,
			children: [
				{ mode: "code", message: "[script:write] write a" },
				{ mode: "code", message: "[script:write2] write b" },
			],
			concurrency: 2,
		})
		const children = pool.getChildTasks(batchId)
		expect(children).toHaveLength(2)
		// Children are never on the task stack. Single-stack paths keep seeing the parent.
		expect(provider.getCurrentTask()).toBe(parent)
		expect(provider.addClineToStack).not.toHaveBeenCalled()
		expect(children.every((child) => child.nonInteractive && child.parentTaskId === parent.taskId)).toBe(true)
		expect((children[0].providerRef.deref() as any).getCurrentTask()).toBe(parent)

		const result = await pool.waitForBatch(batchId)

		expect(result.children.map((c) => c.stopReason)).toEqual(["completed", "completed"])
		expect(result.children.map((c) => c.summary).sort()).toEqual(["done write", "done write2"])
		const [a, b] = result.children
		expect(a.workspace.worktreePath).not.toBe(b.workspace.worktreePath)
		expect(a.workspace.branch).toBe(`roo/subtask/${a.taskId}`)
		expect(a.workspaceSummary).toContain(`branch ${a.workspace.branch}`)
		expect(a.workspaceSummary).toContain("?? a.txt")
		expect(b.workspaceSummary).toContain("?? b.txt")
		expect(fs.readFileSync(path.join(a.workspace.worktreePath, "a.txt"), "utf8")).toBe("hello\n")
		expect(fs.readFileSync(path.join(b.workspace.worktreePath, "b.txt"), "utf8")).toBe("world\n")
		expect(result.children.every((c) => c.refusedApprovals.length === 0)).toBe(true)

		// Parent tree unchanged.
		expect(git(repo, "status", "--porcelain").trim()).toBe("")
		expect(git(repo, "rev-parse", "HEAD").trim()).toBe(parentHead)
		expect(fs.existsSync(path.join(repo, "a.txt"))).toBe(false)

		// The first requests of the two children overlap in time.
		const firsts = ["write", "write2"].map((key) => requests.find((r) => r.key === key && r.step === 0)!)
		expect(overlaps(firsts[0], firsts[1])).toBe(true)

		// Children are saved as ordinary history items with parentTaskId, without webview broadcasts.
		const childItems = provider.history.filter((h: any) => h.item.parentTaskId === parent.taskId)
		expect(childItems.length).toBeGreaterThan(0)
		expect(
			childItems.every((h: any) => h.options?.broadcast === false && h.item.workspaceMode === "isolated"),
		).toBe(true)
		expect(provider.postMessageToWebview).not.toHaveBeenCalled()
		expect(provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()

		expect(await readStop(a.taskId)).toBe("completed")
		expect(await readStop(b.taskId)).toBe("completed")
		expect(formatParallelBatchResult(result)).toContain("stop reason completed")
	}, 30_000)

	it("never overlaps requests with concurrency 1", async () => {
		state.autoApprovalEnabled = true
		state.alwaysAllowWrite = true
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({
			parent,
			children: [
				{ mode: "code", message: "[script:write] a" },
				{ mode: "code", message: "[script:write2] b" },
			],
			concurrency: 1,
		})
		const result = await pool.waitForBatch(batchId)
		expect(result.concurrency).toBe(1)
		expect(result.children.map((c) => c.stopReason)).toEqual(["completed", "completed"])
		expect(requests.length).toBeGreaterThanOrEqual(4)
		for (let i = 0; i < requests.length; i++)
			for (let j = i + 1; j < requests.length; j++) expect(overlaps(requests[i], requests[j])).toBe(false)
	}, 30_000)

	it("denies the request after the budget is exhausted and stops the child with budget-denied", async () => {
		state.autoApprovalEnabled = true
		state.alwaysAllowWrite = true
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({
			parent,
			children: [{ mode: "code", message: "[script:write] a" }],
			tokenBudget: 10,
		})
		const result = await pool.waitForBatch(batchId)
		expect(requests).toHaveLength(1) // the second request never reached the provider
		expect(result.budgetExhausted).toBe(true)
		expect(result.usedTokens).toBe(15)
		expect(result.children[0].stopReason).toBe("budget-denied")
		expect(formatParallelBatchResult(result)).toContain("shared token budget of the batch was exhausted")
		expect(await readStop(result.children[0].taskId)).toBe("budget-denied")
	}, 30_000)

	describe("Q-SEC-3: children cannot ask", () => {
		it("refuses a write when auto-approval for writes is off, and does not write the file", async () => {
			const pool = new ParallelTaskPool(provider)
			const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "[script:write] a" }] })
			const [child] = pool.getChildTasks(batchId)
			const result = await pool.waitForBatch(batchId)
			const [only] = result.children
			expect(only.stopReason).toBe("completed")
			expect(fs.existsSync(path.join(only.workspace.worktreePath, "a.txt"))).toBe(false)
			expect(only.refusedApprovals).toEqual([{ type: "tool", tool: "newFileCreated", detail: "a.txt" }])
			expect(formatParallelBatchResult(result)).toContain("- tool newFileCreated: a.txt")
			// The model received the refusal text.
			expect(JSON.stringify(child.apiConversationHistory)).toContain(PARALLEL_REFUSAL_MESSAGE)
		}, 30_000)

		it("runs the write when auto-approval for writes is on", async () => {
			state.autoApprovalEnabled = true
			state.alwaysAllowWrite = true
			const pool = new ParallelTaskPool(provider)
			const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "[script:write] a" }] })
			const [only] = (await pool.waitForBatch(batchId)).children
			expect(fs.readFileSync(path.join(only.workspace.worktreePath, "a.txt"), "utf8")).toBe("hello\n")
			expect(only.refusedApprovals).toEqual([])
		}, 30_000)

		it("refuses a follow-up question and a mode switch", async () => {
			const pool = new ParallelTaskPool(provider)
			const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "[script:ask] go" }] })
			const [child] = pool.getChildTasks(batchId)
			const [only] = (await pool.waitForBatch(batchId)).children
			expect(only.stopReason).toBe("completed")
			expect(only.refusedApprovals.map((r) => r.type)).toEqual(["followup", "capability"])
			expect(only.refusedApprovals[0].detail).toBe("Which file?")
			expect(only.refusedApprovals[1].tool).toBe("switch_mode")
			expect(provider.getState).toHaveBeenCalled()
			expect(child.taskMode).toBe("code")
		}, 30_000)

		it("refuses to start a nested batch from a child", async () => {
			const pool = new ParallelTaskPool(provider)
			const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "[script:plain] x" }] })
			const [child] = pool.getChildTasks(batchId)
			await expect(
				pool.startBatch({ parent: child, children: [{ mode: "code", message: "y" }] }),
			).rejects.toThrow("cannot start parallel subtasks")
			await pool.waitForBatch(batchId)
		}, 30_000)
	})

	it("stopBatch stops every child with user-stopped", async () => {
		vi.mocked(buildApiHandler).mockImplementation(() => fakeHandler(requests, { hang: true }) as any)
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({
			parent,
			children: [
				{ mode: "code", message: "[script:plain] a" },
				{ mode: "code", message: "[script:plain] b" },
			],
		})
		const children = pool.getChildTasks(batchId)
		await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 })
		const waiting = pool.waitForBatch(batchId)
		await pool.stopBatch(batchId)
		const result = await waiting
		expect(result.children.map((c) => c.stopReason)).toEqual(["user-stopped", "user-stopped"])
		expect(children.every((c) => c.abort)).toBe(true)
		await new Promise((r) => setTimeout(r, 100))
		expect(requests).toHaveLength(2)
		for (const child of result.children) expect(await readStop(child.taskId)).toBe("user-stopped")
	}, 30_000)

	it("stopChild stops one child with user-stopped while the other completes, and reports status changes", async () => {
		const hanging = fakeHandler(requests, { hang: true })
		const normal = fakeHandler(requests)
		vi.mocked(buildApiHandler).mockImplementation(
			() =>
				({
					...normal,
					createMessage: (system: string, messages: any[]) =>
						JSON.stringify(messages[0]).includes("[script:plain] hang")
							? hanging.createMessage(system, messages)
							: normal.createMessage(system, messages),
				}) as any,
		)
		const pool = new ParallelTaskPool(provider)
		const changes = vi.fn()
		pool.onDidChange(changes)
		const batchId = await pool.startBatch({
			parent,
			children: [
				{ mode: "code", message: "[script:plain] hang" },
				{ mode: "code", message: "[script:plain] finish" },
			],
		})
		const [hung, other] = pool.getChildTasks(batchId)
		expect(changes).toHaveBeenCalled()
		await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 })
		const waiting = pool.waitForBatch(batchId)
		await pool.stopChild(batchId, hung.taskId)
		expect(hung.abort).toBe(true)
		const result = await waiting
		expect(result.children.find((c) => c.taskId === hung.taskId)?.stopReason).toBe("user-stopped")
		expect(result.children.find((c) => c.taskId === other.taskId)?.stopReason).toBe("completed")
		// The finished batch stays visible to status views, with UI statuses.
		const info = pool.getBatchInfoForParent(parent.taskId)!
		expect(info.running).toBe(false)
		expect(info.children.map((c) => c.status)).toEqual(["stopped", "completed"])
		expect(info.children[0].branch).toBe(`roo/subtask/${hung.taskId}`)
		expect(pool.getChildTask(batchId, other.taskId)).toBe(other)
		// Unknown IDs do nothing.
		await expect(pool.stopChild("unknown", "x")).resolves.toBeUndefined()
	}, 30_000)

	it("aborting the parent stops its batch", async () => {
		vi.mocked(buildApiHandler).mockImplementation(() => fakeHandler(requests, { hang: true }) as any)
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({
			parent,
			children: [
				{ mode: "code", message: "[script:plain] a" },
				{ mode: "code", message: "[script:plain] b" },
			],
		})
		await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 5_000 })
		const waiting = pool.waitForBatch(batchId)
		const aborted = new Promise<void>((resolve) => parent.once(RooCodeEventName.TaskAborted, () => resolve()))
		await parent.abortTask()
		await aborted
		const result = await waiting
		expect(result.children.map((c) => c.stopReason)).toEqual(["user-stopped", "user-stopped"])
	}, 30_000)

	it("dispose stops every running batch", async () => {
		vi.mocked(buildApiHandler).mockImplementation(() => fakeHandler(requests, { hang: true }) as any)
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "[script:plain] a" }] })
		const [child] = pool.getChildTasks(batchId)
		await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 5_000 })
		await pool.dispose()
		expect(child.abort).toBe(true)
		expect(await readStop(child.taskId)).toBe("abandoned")
		await expect(pool.startBatch({ parent, children: [{ mode: "code", message: "x" }] })).rejects.toThrow(
			"disposed",
		)
	}, 30_000)

	it("gives a child on an OpenAI-compatible handler the batch runtime, and it completes", async () => {
		vi.mocked(buildApiHandler).mockImplementation(
			(configuration: any) =>
				new OpenAiHandler({
					...configuration,
					openAiModelId: "gpt-test",
					openAiApiKey: "test",
					openAiBaseUrl: "http://localhost:9",
				}),
		)
		openAiCreate.mockImplementation(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_openai_1",
										function: { name: "attempt_completion", arguments: '{"result":"done openai"}' },
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				}
				yield { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } }
			},
		}))
		const admit = vi.spyOn(BatchAdmissionRuntime.prototype, "admit")
		const pool = new ParallelTaskPool(provider)
		const batchId = await pool.startBatch({ parent, children: [{ mode: "code", message: "say done" }] })
		const [child] = pool.getChildTasks(batchId)
		expect((child as any).modelDispatchRuntime).toBeInstanceOf(BatchAdmissionRuntime)
		const result = await pool.waitForBatch(batchId)
		expect(result.children[0].stopReason).toBe("completed")
		expect(result.children[0].summary).toBe("done openai")
		expect(admit).toHaveBeenCalled()
		expect(admit.mock.calls[0][0]).toMatchObject({ provider: "openai", model: "gpt-test" })
		expect(result.usedTokens).toBe(10)
	}, 30_000)
})
