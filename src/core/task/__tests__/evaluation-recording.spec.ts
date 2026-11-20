// npx vitest run core/task/__tests__/evaluation-recording.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	abortStopReason,
	buildEvaluationManifest,
	countApiRequests,
	EVALUATION_FILE_NAME,
	EvaluationRecorder,
	writeTaskEvaluationManifest,
} from "../evaluation-recording"

const SECRET_KEY = "sk-ant-api03-SECRETSECRETSECRET"
const SECRET_URL = "https://internal.example.com/v1"
const PROMPT = "Please refactor the payment module with my password hunter2"

describe("evaluation-recording", () => {
	let dir: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-rec-"))
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	const filePath = () => path.join(dir, EVALUATION_FILE_NAME)
	const readRecord = async () => JSON.parse(await fs.readFile(filePath(), "utf8"))
	const exists = () =>
		fs.access(filePath()).then(
			() => true,
			() => false,
		)
	const manifestInput = {
		extensionVersion: "4.2.95",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		mode: "code",
		profile: "cordis",
		settings: {
			experiments: { cordisRuntimePreview: true, evaluationRecording: true },
			autoCondenseContext: true,
			architectureContextMode: "index",
			reasoningEffort: "high",
			modelContextWindowOverride: 200000,
			// Not whitelisted: must be dropped.
			apiKey: SECRET_KEY,
			openAiBaseUrl: SECRET_URL,
		} as Record<string, unknown>,
		prompt: PROMPT,
	}

	it("flag off: writes no file", async () => {
		const recorder = EvaluationRecorder.create(false, {
			taskId: "t1",
			kind: "new",
			getTaskDirectory: async () => dir,
		})
		expect(recorder).toBeUndefined()

		const task = {
			evaluationRecorder: recorder,
			apiConfiguration: { apiProvider: "anthropic" as const },
			getTaskMode: async () => "code",
			providerRef: new WeakRef({ getState: async () => ({}) }),
		}
		await writeTaskEvaluationManifest(task, PROMPT)
		expect(await exists()).toBe(false)
	})

	it("flag on: writes the manifest without a stop", async () => {
		const recorder = EvaluationRecorder.create(true, {
			taskId: "t1",
			kind: "new",
			getTaskDirectory: async () => dir,
		})!
		await recorder.writeManifest({ ...manifestInput, parentTaskId: "p1" })

		const record = await readRecord()
		expect(record).toMatchObject({
			version: 1,
			taskId: "t1",
			parentTaskId: "p1",
			extension: { version: "4.2.95" },
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			mode: "code",
			profile: "cordis",
			settings: {
				experiments: { cordisRuntimePreview: true, evaluationRecording: true },
				autoCondenseContext: true,
				architectureContextMode: "index",
				reasoningEffort: "high",
				modelContextWindowOverride: 200000,
			},
		})
		expect(record.settingsDigest).toMatch(/^[0-9a-f]{16}$/)
		expect(record.promptHash).toMatch(/^[0-9a-f]{16}$/)
		expect(typeof record.createdAt).toBe("string")
		expect(record.stop).toBeUndefined()
		// No temporary files are left next to the record.
		expect(await fs.readdir(dir)).toEqual([EVALUATION_FILE_NAME])
	})

	it("settings digest is stable for equal settings in a different key order", () => {
		const a = buildEvaluationManifest({ ...manifestInput, taskId: "a" })
		const b = buildEvaluationManifest({
			...manifestInput,
			taskId: "b",
			settings: { reasoningEffort: "high", ...manifestInput.settings },
		})
		expect(a.settingsDigest).toBe(b.settingsDigest)
	})

	it("records the stop once; a second call is ignored", async () => {
		const recorder = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		await recorder.writeManifest(manifestInput)
		await recorder.recordStop("completed", 3)
		await recorder.recordStop("abandoned", 9)
		await recorder.flush()

		const record = await readRecord()
		expect(record.stop).toMatchObject({ reason: "completed", apiRequests: 3 })
		expect(record.provider).toBe("anthropic")
	})

	it("keeps a stop that arrives before the manifest", async () => {
		const recorder = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		void recorder.recordStop("user-stopped", 0)
		await recorder.writeManifest(manifestInput)
		const record = await readRecord()
		expect(record.stop?.reason).toBe("user-stopped")
		expect(record.modelId).toBe("claude-sonnet-4-5")
	})

	it("suspended stops (delegation) are not recorded", async () => {
		const recorder = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		await recorder.writeManifest(manifestInput)
		recorder.suspendStops(true)
		await recorder.recordStop("abandoned", 1)
		recorder.suspendStops(false)
		await recorder.recordStop("completed", 2)
		expect((await readRecord()).stop.reason).toBe("completed")
	})

	it("resumed task: adds a stop only to its own existing file without a stop", async () => {
		const first = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		await first.writeManifest(manifestInput)

		const resumed = new EvaluationRecorder({ taskId: "t1", kind: "attach", getTaskDirectory: async () => dir })
		await resumed.writeManifest(manifestInput) // ignored for resumed instances
		await resumed.recordStop("error", 4)
		expect((await readRecord()).stop).toMatchObject({ reason: "error", apiRequests: 4 })

		// A later resume keeps the first stop reason.
		const again = new EvaluationRecorder({ taskId: "t1", kind: "attach", getTaskDirectory: async () => dir })
		await again.recordStop("completed", 8)
		expect((await readRecord()).stop.reason).toBe("error")
	})

	it("resumed task created before the flag was on: writes nothing", async () => {
		const resumed = new EvaluationRecorder({ taskId: "t1", kind: "attach", getTaskDirectory: async () => dir })
		await resumed.recordStop("completed", 1)
		expect(await exists()).toBe(false)
	})

	it("no secrets: API keys, URLs and prompt text never appear in the file", async () => {
		const recorder = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		await recorder.writeManifest({
			...manifestInput,
			settings: {
				...manifestInput.settings,
				// A secret pasted into an enum-like field is dropped, not copied.
				architectureContextMode: SECRET_KEY + " " + SECRET_URL,
				experiments: { [SECRET_URL]: true, ok: true },
			},
			modelId: `${SECRET_URL} ${PROMPT}`,
		})
		await recorder.recordStop("completed", 1)

		const text = await fs.readFile(filePath(), "utf8")
		expect(text).not.toContain(SECRET_KEY)
		expect(text).not.toContain(SECRET_URL)
		expect(text).not.toContain("internal.example.com")
		expect(text).not.toContain("hunter2")
		expect(text).not.toContain("payment module")
	})

	it("writeTaskEvaluationManifest passes only named settings from task state", async () => {
		const recorder = new EvaluationRecorder({ taskId: "t1", kind: "new", getTaskDirectory: async () => dir })
		await writeTaskEvaluationManifest(
			{
				evaluationRecorder: recorder,
				profile: "modes",
				apiConfiguration: {
					apiProvider: "openai",
					openAiModelId: "gpt-5",
					openAiApiKey: SECRET_KEY,
					openAiBaseUrl: SECRET_URL,
					openAiHeaders: { Authorization: SECRET_KEY },
					reasoningEffort: "medium",
				},
				getTaskMode: async () => "architect",
				providerRef: new WeakRef({
					getState: async () => ({
						experiments: { evaluationRecording: true },
						pruneToolResultsOnOverflow: true,
						apiConfiguration: { anthropicApiKey: SECRET_KEY },
						customInstructions: PROMPT,
					}),
				}),
			},
			PROMPT,
		)
		const text = await fs.readFile(filePath(), "utf8")
		const record = JSON.parse(text)
		expect(record).toMatchObject({ provider: "openai", modelId: "gpt-5", mode: "architect", profile: "modes" })
		expect(record.settings).toEqual({
			experiments: { evaluationRecording: true },
			pruneToolResultsOnOverflow: true,
			reasoningEffort: "medium",
		})
		expect(text).not.toContain(SECRET_KEY)
		expect(text).not.toContain(SECRET_URL)
		expect(text).not.toContain("hunter2")
	})

	it("write failure is swallowed and logged", async () => {
		const log = vi.fn()
		const recorder = new EvaluationRecorder({
			taskId: "t1",
			kind: "new",
			getTaskDirectory: async () => dir,
			write: async () => {
				throw new Error("disk full")
			},
			log,
		})
		await expect(recorder.writeManifest(manifestInput)).resolves.toBeUndefined()
		await expect(recorder.recordStop("completed", 1)).resolves.toBeUndefined()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("disk full"))

		// A failing directory lookup is also swallowed.
		const broken = new EvaluationRecorder({
			taskId: "t2",
			kind: "new",
			getTaskDirectory: async () => {
				throw new Error("no storage")
			},
			log,
		})
		await expect(broken.recordStop("error", 0)).resolves.toBeUndefined()
	})

	it("abortStopReason and countApiRequests", () => {
		expect(abortStopReason({ abortReason: "user_cancelled" })).toBe("user-stopped")
		expect(abortStopReason({ lastAsk: "api_req_failed" })).toBe("error")
		expect(abortStopReason({})).toBe("abandoned")
		expect(countApiRequests([{ say: "api_req_started" }, { say: "text" }, { say: "api_req_started" }])).toBe(2)
		expect(countApiRequests(undefined)).toBe(0)
	})
})
