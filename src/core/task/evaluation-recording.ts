import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import { getModelId, type ProviderSettings } from "@roo-code/types"

import { Package } from "../../shared/package"
import { safeWriteJson } from "../../utils/safeWriteJson"

/**
 * Evaluation recording (experiment `evaluationRecording`, default off).
 * ADR-2026-11-20-feature-gating-evaluation-and-lessons.
 *
 * A task created while the experiment is on writes one `evaluation.json` in its own task folder:
 * a run manifest at task start, then a single stop reason at the first terminal event.
 * Constraints: additive, own folder only (C-5); no prompt text or secrets, only hashes and plain IDs
 * (Q-SEC-2); no extra service (C-1); best effort, a failure never fails or blocks the task.
 */

export const EVALUATION_FILE_NAME = "evaluation.json"

export const evaluationStopReasons = ["completed", "user-stopped", "error", "mistake-limit", "abandoned"] as const
export type EvaluationStopReason = (typeof evaluationStopReasons)[number]

/** Plain, non-secret settings that affect behaviour. Any other key is dropped. */
export interface EvaluationSettings {
	experiments?: Record<string, boolean>
	architectureContextMode?: string
	autoCondenseContext?: boolean
	pruneToolResultsOnOverflow?: boolean
	offloadImagesOnOverflow?: boolean
	cordisTextOnlyTurnPolicy?: string
	modelContextWindowOverride?: number
	reasoningEffort?: string
}

export interface EvaluationManifestInput {
	taskId: string
	parentTaskId?: string
	extensionVersion: string
	extensionCommit?: string
	provider?: string
	modelId?: string
	mode?: string
	profile?: string
	/** Raw values. Only the whitelisted, plain-typed fields are kept. */
	settings: Record<string, unknown>
	/** First user message text. Only its hash is stored. */
	prompt?: string
	createdAt?: Date
}

export interface EvaluationRecord {
	version: 1
	taskId: string
	parentTaskId?: string
	createdAt?: string
	extension?: { version: string; commit?: string }
	provider?: string
	modelId?: string
	mode?: string
	profile?: string
	settingsDigest?: string
	settings?: EvaluationSettings
	promptHash?: string
	stop?: { reason: EvaluationStopReason; at: string; apiRequests: number }
}

export function shortHash(value: string): string {
	return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)
}

/** JSON with sorted object keys, so equal settings always give the same digest. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
	}
	return JSON.stringify(value) ?? "null"
}

const BOOLEAN_KEYS = ["autoCondenseContext", "pruneToolResultsOnOverflow", "offloadImagesOnOverflow"] as const
const ENUM_KEYS = ["architectureContextMode", "cordisTextOnlyTurnPolicy", "reasoningEffort"] as const
// Enum-like values are short identifiers. Anything else (for example a pasted key) is dropped.
const IDENTIFIER = /^[A-Za-z0-9_-]{1,32}$/

/** Keep only whitelisted keys with plain types. Never copies free text, URLs, keys or headers. */
export function pickEvaluationSettings(raw: Record<string, unknown>): EvaluationSettings {
	const settings: EvaluationSettings = {}
	const experiments = raw.experiments
	if (experiments && typeof experiments === "object") {
		const flags: Record<string, boolean> = {}
		for (const [key, value] of Object.entries(experiments as Record<string, unknown>)) {
			if (typeof value === "boolean" && IDENTIFIER.test(key)) flags[key] = value
		}
		settings.experiments = flags
	}
	for (const key of BOOLEAN_KEYS) {
		if (typeof raw[key] === "boolean") settings[key] = raw[key] as boolean
	}
	for (const key of ENUM_KEYS) {
		const value = raw[key]
		if (typeof value === "string" && IDENTIFIER.test(value)) settings[key] = value
	}
	const override = raw.modelContextWindowOverride
	if (typeof override === "number" && Number.isFinite(override)) settings.modelContextWindowOverride = override
	return settings
}

export function buildEvaluationManifest(input: EvaluationManifestInput): EvaluationRecord {
	const settings = pickEvaluationSettings(input.settings)
	const plain = (value?: string) => (typeof value === "string" && IDENTIFIER_OR_MODEL.test(value) ? value : undefined)
	return {
		version: 1,
		taskId: input.taskId,
		...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
		createdAt: (input.createdAt ?? new Date()).toISOString(),
		extension: {
			version: input.extensionVersion,
			...(input.extensionCommit ? { commit: input.extensionCommit } : {}),
		},
		provider: plain(input.provider),
		modelId: plain(input.modelId),
		mode: plain(input.mode),
		profile: plain(input.profile),
		settingsDigest: shortHash(canonicalJson(settings)),
		settings,
		...(input.prompt ? { promptHash: shortHash(input.prompt) } : {}),
	}
}

// Provider, model, mode and profile IDs: no whitespace, bounded length (model IDs may contain / : . @).
const IDENTIFIER_OR_MODEL = /^[A-Za-z0-9_./:@+-]{1,200}$/

export interface EvaluationRecorderOptions {
	taskId: string
	/** Resolves this task's own folder. Never another task's folder (C-5). */
	getTaskDirectory: () => Promise<string>
	/**
	 * "new": the task was created while the experiment was on; it writes the manifest and the stop.
	 * "attach": a resumed instance; it only adds the stop to an existing file of its own that has none.
	 */
	kind: "new" | "attach"
	write?: (filePath: string, data: unknown) => Promise<void>
	read?: (filePath: string) => Promise<string>
	log?: (message: string) => void
}

export class EvaluationRecorder {
	private record: EvaluationRecord
	private stop?: EvaluationRecord["stop"]
	private stopRecorded = false
	private stopsSuspended = false
	private queue: Promise<void> = Promise.resolve()
	private readonly write: (filePath: string, data: unknown) => Promise<void>
	private readonly read: (filePath: string) => Promise<string>
	private readonly log: (message: string) => void

	/** Returns a recorder only when the experiment was on when this instance was created. */
	static create(enabled: boolean, options: EvaluationRecorderOptions): EvaluationRecorder | undefined {
		return enabled ? new EvaluationRecorder(options) : undefined
	}

	constructor(private readonly options: EvaluationRecorderOptions) {
		this.record = { version: 1, taskId: options.taskId }
		this.write = options.write ?? ((filePath, data) => safeWriteJson(filePath, data, { prettyPrint: true }))
		this.read = options.read ?? ((filePath) => fs.readFile(filePath, "utf8"))
		this.log = options.log ?? ((message) => console.warn(message))
	}

	get kind() {
		return this.options.kind
	}

	/** Write the manifest (new tasks only). Best effort. */
	writeManifest(input: Omit<EvaluationManifestInput, "taskId">): Promise<void> {
		if (this.options.kind !== "new") return this.queue
		try {
			this.record = buildEvaluationManifest({ ...input, taskId: this.options.taskId })
		} catch (error) {
			this.log(`[evaluation-recording] manifest build failed: ${errorText(error)}`)
			return this.queue
		}
		// A stop recorded before the manifest was ready is kept.
		return this.enqueue(() => this.persist())
	}

	/**
	 * Delegation disposes the parent instance without ending the task.
	 * Suspend stop recording around it, so the parent is not recorded as abandoned.
	 */
	suspendStops(suspended: boolean): void {
		this.stopsSuspended = suspended
	}

	/** Record the first terminal event. Later calls are ignored. Best effort. */
	recordStop(reason: EvaluationStopReason, apiRequests: number): Promise<void> {
		if (this.stopRecorded || this.stopsSuspended) return this.queue
		this.stopRecorded = true
		const stop = {
			reason,
			at: new Date().toISOString(),
			apiRequests: Number.isFinite(apiRequests) ? apiRequests : 0,
		}
		return this.enqueue(async () => {
			if (this.options.kind === "attach") {
				const existing = await this.readOwn()
				// Created before the experiment was on, or already stopped: write nothing.
				if (!existing || existing.stop) return
				this.record = existing
			}
			this.stop = stop
			await this.persist()
		})
	}

	/** Resolves when queued writes have settled. Never rejects. */
	flush(): Promise<void> {
		return this.queue
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.queue = this.queue.then(work).catch((error) => {
			this.log(`[evaluation-recording] write failed for task ${this.options.taskId}: ${errorText(error)}`)
		})
		return this.queue
	}

	private async filePath(): Promise<string> {
		return path.join(await this.options.getTaskDirectory(), EVALUATION_FILE_NAME)
	}

	private async persist(): Promise<void> {
		const record: EvaluationRecord = this.stop ? { ...this.record, stop: this.stop } : { ...this.record }
		await this.write(await this.filePath(), record)
	}

	private async readOwn(): Promise<EvaluationRecord | undefined> {
		let text: string
		try {
			text = await this.read(await this.filePath())
		} catch {
			return undefined // Missing file is normal (C-5 readers tolerate it).
		}
		try {
			const parsed = JSON.parse(text)
			if (parsed && parsed.version === 1 && parsed.taskId === this.options.taskId) return parsed
		} catch {
			// A damaged file is left as is.
		}
		return undefined
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** The parts of a Task that the manifest needs. Structural, so Task.ts keeps only small hooks (R-1). */
export interface EvaluationTaskSource {
	readonly evaluationRecorder?: EvaluationRecorder
	readonly parentTaskId?: string
	readonly profile?: string
	apiConfiguration: ProviderSettings
	getTaskMode(): Promise<string>
	providerRef: WeakRef<{ getState(): Promise<unknown> }>
}

/** Build and write the manifest for a new task. Best effort: never throws. */
export async function writeTaskEvaluationManifest(task: EvaluationTaskSource, prompt?: string): Promise<void> {
	const recorder = task.evaluationRecorder
	if (!recorder || recorder.kind !== "new") return
	try {
		const state = ((await task.providerRef.deref()?.getState()) ?? {}) as Record<string, unknown>
		const api = task.apiConfiguration ?? ({} as ProviderSettings)
		let mode: string | undefined
		try {
			mode = await task.getTaskMode()
		} catch {
			mode = undefined
		}
		await recorder.writeManifest({
			parentTaskId: task.parentTaskId,
			extensionVersion: Package.version,
			extensionCommit: Package.sha,
			provider: api.apiProvider,
			modelId: getModelId(api),
			mode,
			profile: task.profile,
			// Only named, non-secret fields. API keys, base URLs and headers are never passed (Q-SEC-2).
			settings: {
				experiments: state.experiments,
				architectureContextMode: state.architectureContextMode,
				autoCondenseContext: state.autoCondenseContext,
				pruneToolResultsOnOverflow: state.pruneToolResultsOnOverflow,
				offloadImagesOnOverflow: state.offloadImagesOnOverflow,
				cordisTextOnlyTurnPolicy: state.cordisTextOnlyTurnPolicy,
				modelContextWindowOverride: api.modelContextWindowOverride,
				reasoningEffort: api.reasoningEffort,
			},
			prompt,
		})
	} catch (error) {
		console.warn(`[evaluation-recording] manifest skipped: ${errorText(error)}`)
	}
}

/**
 * Stop reason for an abort. A user cancel is "user-stopped". A close while a failed request was
 * waiting for retry is "error". Any other close (another task opened, panel or host closed) is "abandoned".
 */
export function abortStopReason(input: {
	abortReason?: string
	lastAsk?: string
}): Extract<EvaluationStopReason, "user-stopped" | "error" | "abandoned"> {
	if (input.abortReason === "user_cancelled") return "user-stopped"
	if (input.lastAsk === "api_req_failed") return "error"
	return "abandoned"
}

/** Number of model requests shown in the task (one `api_req_started` row each). */
export function countApiRequests(messages: ReadonlyArray<{ say?: string }> | undefined): number {
	return messages?.filter((message) => message.say === "api_req_started").length ?? 0
}
