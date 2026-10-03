import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
	BRANCH_COMMAND_ARTIFACT_LIMITS,
	copyBranchCommandArtifacts,
	readBranchProvenance,
	readBranchReplaySnapshot,
	readRequestSnapshot,
	saveBranchProvenance,
	saveBranchReplay,
	saveRequestSnapshot,
	type BranchProvenance,
	type RequestSnapshot,
} from "../storage"

// Keep real filesystem behavior while allowing targeted fsync failure injection.
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
}))

let root: string
const snapshot = (): RequestSnapshot => ({
	version: 1,
	taskId: "task-1",
	requestId: "request-1",
	createdAt: 123,
	apiMessages: [
		{ role: "user", content: "question" },
		{ role: "assistant", content: "prior answer", id: "response-prior", reasoning_content: "opaque" },
		{ role: "user", content: "followup" },
	],
	clineMessages: [
		{ ts: 1, type: "say", say: "text", text: "question" },
		{ ts: 2, type: "say", say: "text", text: "prior answer", requestId: "prior" },
		{ ts: 3, type: "say", say: "api_req_started", requestId: "request-1" },
	],
	systemPrompt: "system prompt",
	sourceProvider: "provider",
	sourceModelId: "model",
})
const provenance = (): BranchProvenance => ({
	version: 1,
	operationId: "operation-1",
	kind: "switch",
	sourceTaskId: "task-1",
	sourceRequestId: "request-1",
	targetProfileId: "profile-1",
	createdAt: 124,
	workspacePath: path.resolve("workspace"),
	requiresToolApproval: true,
})
const snapshotPath = () => path.join(root, "tasks/task-1/model-operation/request-request-1.json")
const provenancePath = (task = "branch-1") => path.join(root, "tasks", task, "model-operation/branch-provenance.json")

// Independent canonical hashing permits testing schema/identity validation even
// when a malformed record has a matching checksum.
function stable(value: any): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
		.join(",")}}`
}
async function editRecord(file: string, edit: (record: any) => void, rehash = false): Promise<void> {
	const record = JSON.parse(await fs.readFile(file, "utf8"))
	edit(record)
	if (rehash) {
		const { checksum: _checksum, ...unsigned } = record
		record.checksum = createHash("sha256").update(stable(unsigned)).digest("hex")
	}
	await fs.writeFile(file, JSON.stringify(record))
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "model-operation-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

describe("request snapshot storage", () => {
	it("creates parents, persists exact request prefixes, and survives module reload", async () => {
		const input = snapshot()
		await saveRequestSnapshot(root, input)
		vi.resetModules()
		const reloaded = await import("../storage")
		expect(await reloaded.readRequestSnapshot(root, input.taskId, input.requestId)).toEqual(input)
		const disk = JSON.parse(await fs.readFile(snapshotPath(), "utf8"))
		expect(disk.checksum).toMatch(/^[a-f0-9]{64}$/)
		expect(disk.recordType).toBe("requestSnapshot")
		expect(await fs.readdir(path.dirname(snapshotPath()))).toEqual(["request-request-1.json"])
	})

	it("detaches before asynchronous work and returns fresh copies on every read", async () => {
		const original = snapshot()
		const expected = snapshot()
		const pending = saveRequestSnapshot(root, original)
		original.apiMessages[0].content = "mutated"
		original.clineMessages[0].text = "mutated"
		await pending
		const first = await readRequestSnapshot(root, "task-1", "request-1")
		expect(first).toEqual(expected)
		first!.apiMessages.pop()
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(expected)
	})

	it("accepts identical retries independent of insertion order, without replacing the file", async () => {
		const input = snapshot()
		await saveRequestSnapshot(root, input)
		const before = await fs.stat(snapshotPath())
		const reversed = Object.fromEntries(Object.entries(input).reverse()) as RequestSnapshot
		await saveRequestSnapshot(root, reversed)
		expect((await fs.stat(snapshotPath())).ino).toBe(before.ino)
		await expect(saveRequestSnapshot(root, { ...input, systemPrompt: "different" })).rejects.toThrow("collision")
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(input)
	})

	it("preserves nested UI metadata and includes it in immutable identity", async () => {
		const input = snapshot()
		input.clineMessages[0].progressStatus = { text: "progress", future: { value: "original" } } as any
		await saveRequestSnapshot(root, input)
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(input)
		expect(JSON.parse(await fs.readFile(snapshotPath(), "utf8")).payload).toEqual(input)
		;(input.clineMessages[0].progressStatus as any).future.value = "changed"
		await expect(saveRequestSnapshot(root, input)).rejects.toThrow("collision")
	})

	it("publishes only one winner for conflicting concurrent saves", async () => {
		const values = Array.from({ length: 8 }, (_, i) => ({ ...snapshot(), systemPrompt: `prompt-${i}` }))
		const outcomes = await Promise.allSettled(values.map((value) => saveRequestSnapshot(root, value)))
		expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		for (const result of outcomes) {
			if (result.status === "rejected") expect(result.reason.message).toContain("collision")
		}
		const winner = outcomes.findIndex((result) => result.status === "fulfilled")
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(values[winner])
		expect(await fs.readdir(path.dirname(snapshotPath()))).toHaveLength(1)
	})

	it("accepts concurrent identical saves and independent request IDs", async () => {
		await Promise.all(Array.from({ length: 5 }, () => saveRequestSnapshot(root, snapshot())))
		await saveRequestSnapshot(root, { ...snapshot(), requestId: "request-2", clineMessages: [] })
		expect(await readRequestSnapshot(root, "task-1", "request-2")).toMatchObject({ requestId: "request-2" })
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(snapshot())
	})

	it("returns undefined for absent data without creating directories", async () => {
		expect(await readRequestSnapshot(root, "absent", "request")).toBeUndefined()
		expect(await readBranchProvenance(root, "absent")).toBeUndefined()
		expect(await fs.readdir(root)).toEqual([])
	})

	it.each([
		"../escape",
		"a/b",
		"a\\b",
		"..",
		".",
		"",
		"/absolute",
		"a:b",
		"a\0b",
		"a.",
		"CON",
		"nul",
		"a".repeat(129),
	])("rejects unsafe path identity %j for reads and writes", async (id) => {
		await expect(saveRequestSnapshot(root, { ...snapshot(), taskId: id })).rejects.toThrow()
		await expect(saveRequestSnapshot(root, { ...snapshot(), requestId: id })).rejects.toThrow()
		await expect(readRequestSnapshot(root, id, "request")).rejects.toThrow()
		await expect(readRequestSnapshot(root, "task", id)).rejects.toThrow()
		await expect(saveBranchProvenance(root, id, provenance())).rejects.toThrow()
		await expect(readBranchProvenance(root, id)).rejects.toThrow()
		expect(await fs.readdir(root)).toEqual([])
	})

	it("rejects relative storage roots", async () => {
		await expect(saveRequestSnapshot("relative", snapshot())).rejects.toThrow("absolute")
		await expect(readRequestSnapshot("relative", "task", "request")).rejects.toThrow("absolute")
	})

	it.each([
		{ version: 2 },
		{ createdAt: -1 },
		{ createdAt: 1.5 },
		{ systemPrompt: null },
		{ sourceProvider: " \t" },
		{ sourceModelId: "\n" },
		{ apiMessages: [] },
		{ apiMessages: [{ role: "system", content: "bad" }] },
		{ apiMessages: [{ role: "assistant", content: "response" }] },
		{ apiMessages: [{ role: "user", content: [{}] }] },
		{ clineMessages: [{ ts: 1, type: "bogus" }] },
		{ extra: true },
	])("rejects invalid snapshots %j", async (fields) => {
		await expect(saveRequestSnapshot(root, { ...snapshot(), ...fields } as RequestSnapshot)).rejects.toThrow()
		expect(await fs.readdir(root)).toEqual([])
	})

	it("rejects UI response rows and non-terminal current request markers", async () => {
		for (const clineMessages of [
			[{ ts: 1, type: "say", say: "text", text: "response", requestId: "request-1" }],
			[
				{ ts: 1, type: "say", say: "api_req_started", requestId: "request-1" },
				{ ts: 2, type: "say", say: "text", text: "response" },
			],
		]) {
			await expect(
				saveRequestSnapshot(root, { ...snapshot(), clineMessages } as RequestSnapshot),
			).rejects.toThrow("UI prefix")
		}
	})

	it("allows an untagged prefix and preserves multimodal payloads for later compatibility checks", async () => {
		const input = snapshot()
		input.clineMessages = []
		input.apiMessages = [
			{
				role: "user",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } }],
			},
		]
		await saveRequestSnapshot(root, input)
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(input)
	})

	it.each([NaN, Infinity, () => "value", 1n, new Date()])("rejects lossy JSON values %s", async (value) => {
		const input = snapshot()
		;(input.apiMessages[0] as any).extra = value
		await expect(saveRequestSnapshot(root, input)).rejects.toThrow("JSON")
	})

	it("rejects cycles, accessors, sparse arrays and unsafe object keys", async () => {
		const cyclic = snapshot()
		;(cyclic.apiMessages[0] as any).extra = cyclic
		await expect(saveRequestSnapshot(root, cyclic)).rejects.toThrow("cycle")
		const getter = vi.fn(() => "unsafe")
		const accessor = snapshot()
		Object.defineProperty(accessor, "systemPrompt", { enumerable: true, get: getter })
		await expect(saveRequestSnapshot(root, accessor)).rejects.toThrow("accessor")
		expect(getter).not.toHaveBeenCalled()
		const sparse = snapshot()
		delete sparse.apiMessages[0]
		await expect(saveRequestSnapshot(root, sparse)).rejects.toThrow()
		const unsafe = snapshot()
		;(unsafe.apiMessages[0] as any).extra = JSON.parse('{"__proto__":{}}')
		await expect(saveRequestSnapshot(root, unsafe)).rejects.toThrow("unsafe key")
	})

	it("detects tampering and refuses to overwrite a corrupted record", async () => {
		await saveRequestSnapshot(root, snapshot())
		await editRecord(snapshotPath(), (record) => (record.payload.systemPrompt = "tampered"))
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow("checksum")
		await expect(saveRequestSnapshot(root, snapshot())).rejects.toThrow("checksum")
	})

	it.each([
		(record: any) => (record.version = 2),
		(record: any) => (record.payload.version = 2),
		(record: any) => (record.taskId = "different"),
		(record: any) => (record.requestId = "different"),
		(record: any) => (record.payload.taskId = "different"),
		(record: any) => (record.payload.requestId = "different"),
		(record: any) => (record.recordType = "branchProvenance"),
		(record: any) => (record.payload.apiMessages = [{ role: "assistant", content: "response" }]),
	])("validates versions, identities and prefixes even with a matching checksum (%#)", async (edit) => {
		await saveRequestSnapshot(root, snapshot())
		await editRecord(snapshotPath(), edit, true)
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow()
	})

	it("does not treat malformed JSON or filesystem failures as missing", async () => {
		await saveRequestSnapshot(root, snapshot())
		await fs.writeFile(snapshotPath(), "{")
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow()
		await fs.unlink(snapshotPath())
		await fs.mkdir(snapshotPath())
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow()
	})

	it("refuses symlinked task directories and records", async () => {
		await fs.mkdir(path.join(root, "tasks"))
		await fs.mkdir(path.join(root, "outside"))
		await fs.symlink(path.join(root, "outside"), path.join(root, "tasks/task-1"), "dir")
		await expect(saveRequestSnapshot(root, snapshot())).rejects.toThrow("symlinks")
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow("symlinks")
		await fs.unlink(path.join(root, "tasks/task-1"))
		await saveRequestSnapshot(root, snapshot())
		await fs.rename(snapshotPath(), path.join(root, "outside/record.json"))
		await fs.symlink(path.join(root, "outside/record.json"), snapshotPath())
		await expect(readRequestSnapshot(root, "task-1", "request-1")).rejects.toThrow("symlinks")
	})
})

describe("branch provenance storage", () => {
	it("persists mandatory approval independently of request/API/UI history and across reloads", async () => {
		await saveBranchProvenance(root, "branch-1", provenance())
		vi.resetModules()
		const reloaded = await import("../storage")
		expect(await reloaded.readBranchProvenance(root, "branch-1")).toEqual(provenance())
		expect(await fs.readdir(path.join(root, "tasks/branch-1"))).toEqual(["model-operation"])
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toBeUndefined()
	})

	it("accepts retries but cannot replace policy or source identity", async () => {
		await Promise.all(Array.from({ length: 5 }, () => saveBranchProvenance(root, "branch-1", provenance())))
		await expect(
			saveBranchProvenance(root, "branch-1", { ...provenance(), operationId: "different" }),
		).rejects.toThrow("collision")
		expect(await readBranchProvenance(root, "branch-1")).toEqual(provenance())
	})

	it.each([
		{ version: 2 },
		{ requiresToolApproval: false },
		{ requiresToolApproval: undefined },
		{ kind: "unknown" },
		{ sourceTaskId: "../escape" },
		{ sourceRequestId: "a/b" },
		{ workspacePath: "relative" },
		{ targetProfileId: "" },
		{ targetProfileId: " \t" },
		{ operationId: "\n" },
	])("rejects invalid provenance %j", async (fields) => {
		await expect(
			saveBranchProvenance(root, "branch-1", { ...provenance(), ...fields } as BranchProvenance),
		).rejects.toThrow()
	})

	it("binds provenance to the destination task and validates persisted approval", async () => {
		await saveBranchProvenance(root, "branch-1", provenance())
		await fs.mkdir(path.dirname(provenancePath("branch-2")), { recursive: true })
		await fs.copyFile(provenancePath(), provenancePath("branch-2"))
		await expect(readBranchProvenance(root, "branch-2")).rejects.toThrow("identity")
		await editRecord(provenancePath(), (record) => (record.payload.requiresToolApproval = false), true)
		await expect(readBranchProvenance(root, "branch-1")).rejects.toThrow()
	})
})

describe.each(["snapshot", "provenance"])("%s durability", (kind) => {
	const save = () =>
		kind === "snapshot"
			? saveRequestSnapshot(root, snapshot())
			: saveBranchProvenance(root, "branch-1", provenance())
	const file = () => (kind === "snapshot" ? snapshotPath() : provenancePath())

	it.skipIf(process.platform === "win32")(
		"syncs the published file and every directory through the trusted root",
		async () => {
			const synced: string[] = []
			const open = fs.open
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args)
				const sync = handle.sync.bind(handle)
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					synced.push(String(args[0]))
					await sync()
				})
				return handle
			})
			await save()
			const directories = [
				path.dirname(file()),
				path.dirname(path.dirname(file())),
				path.join(root, "tasks"),
				root,
			]
			expect(synced.slice(-5)).toEqual([file(), ...directories])
			synced.length = 0
			await save()
			expect(synced).toEqual([file(), ...directories])
		},
	)

	it.skipIf(process.platform === "win32")(
		"does not turn a failed directory sync into a successful identical retry",
		async () => {
			const open = fs.open
			const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args)
				if (String(args[0]) === path.dirname(file())) {
					vi.spyOn(handle, "sync").mockRejectedValue(new Error("directory sync failed"))
				}
				return handle
			})
			await expect(save()).rejects.toThrow("directory sync failed")
			const inode = (await fs.stat(file())).ino
			await expect(save()).rejects.toThrow("directory sync failed")
			spy.mockRestore()
			await save()
			expect((await fs.stat(file())).ino).toBe(inode)
		},
	)
})

const artifactPath = (task = "task-1", name = "cmd-123.txt") => path.join(root, "tasks", task, "command-output", name)
async function writeArtifact(task = "task-1", name = "cmd-123.txt", content: string | Buffer = "command output") {
	const file = artifactPath(task, name)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, content)
	return file
}

describe("branch-owned replay", () => {
	it("survives source deletion and reload, including command output and exact prefix metadata", async () => {
		const input = snapshot()
		const expected = structuredClone(input)
		await writeArtifact()
		await saveRequestSnapshot(root, input)
		const pending = saveBranchReplay(root, "branch-1", input, provenance())
		input.systemPrompt = "mutated"
		const origin = await pending
		expect(origin).toEqual({ ...provenance(), replaySnapshotRequestId: "request-1" })
		expect(await readRequestSnapshot(root, "task-1", "request-1")).toEqual(expected)
		await fs.rm(path.join(root, "tasks/task-1"), { recursive: true })
		vi.resetModules()
		const reloaded = await import("../storage")
		const saved = await reloaded.readBranchProvenance(root, "branch-1")
		expect(await reloaded.readBranchReplaySnapshot(root, "branch-1", saved!)).toEqual({
			...expected,
			taskId: "branch-1",
		})
		expect(await fs.readFile(artifactPath("branch-1"), "utf8")).toBe("command output")
	})

	it("branches a branch without consulting either ancestor at reload", async () => {
		await writeArtifact()
		const first = await saveBranchReplay(root, "branch-1", snapshot(), provenance())
		const local = await readBranchReplaySnapshot(root, "branch-1", first)
		await fs.rm(path.join(root, "tasks/task-1"), { recursive: true })
		const second = await saveBranchReplay(root, "branch-2", local!, {
			...provenance(),
			sourceTaskId: "branch-1",
			operationId: "operation-2",
		})
		await fs.rm(path.join(root, "tasks/branch-1"), { recursive: true })
		expect(await readBranchReplaySnapshot(root, "branch-2", second)).toEqual({ ...snapshot(), taskId: "branch-2" })
		expect(await fs.readFile(artifactPath("branch-2"), "utf8")).toBe("command output")
	})

	it("retains legacy provenance and its one exact source lookup without upgrading it implicitly", async () => {
		await saveRequestSnapshot(root, snapshot())
		await saveBranchProvenance(root, "branch-1", provenance())
		const legacy = await readBranchProvenance(root, "branch-1")
		expect(legacy).toEqual(provenance())
		expect(await readBranchReplaySnapshot(root, "branch-1", legacy!)).toEqual(snapshot())
		await fs.rm(path.join(root, "tasks/task-1"), { recursive: true })
		expect(await readBranchReplaySnapshot(root, "branch-1", legacy!)).toBeUndefined()
	})

	it("never falls back to the source for missing or corrupt branch-local snapshots", async () => {
		await saveRequestSnapshot(root, snapshot())
		const local = await saveBranchReplay(root, "branch-1", snapshot(), provenance())
		const file = path.join(root, "tasks/branch-1/model-operation/request-request-1.json")
		await fs.writeFile(file, "invalid")
		await expect(readBranchReplaySnapshot(root, "branch-1", local)).rejects.toThrow()
		await fs.unlink(file)
		expect(await readBranchReplaySnapshot(root, "branch-1", local)).toBeUndefined()
	})

	it("validates provenance and rejects source/destination aliasing before writing", async () => {
		await expect(
			saveBranchReplay(root, "branch-1", snapshot(), { ...provenance(), sourceTaskId: "other" }),
		).rejects.toThrow("identity")
		await expect(
			saveBranchReplay(root, "branch-1", snapshot(), { ...provenance(), replaySnapshotRequestId: "other" }),
		).rejects.toThrow()
		await expect(saveBranchReplay(root, "task-1", snapshot(), provenance())).rejects.toThrow("distinct")
		await expect(saveBranchReplay(root, "../escape", snapshot(), provenance())).rejects.toThrow()
		expect(await fs.readdir(root)).toEqual([])
	})

	it("does not publish provenance or snapshot when artifact copying fails", async () => {
		await writeArtifact()
		await writeArtifact("branch-1", "cmd-123.txt", "collision")
		await expect(saveBranchReplay(root, "branch-1", snapshot(), provenance())).rejects.toThrow("collision")
		expect(await readBranchProvenance(root, "branch-1")).toBeUndefined()
		expect(await readRequestSnapshot(root, "branch-1", "request-1")).toBeUndefined()
	})

	it("supports exact concurrent retries and refuses to replace legacy provenance", async () => {
		await writeArtifact()
		await Promise.all(Array.from({ length: 3 }, () => saveBranchReplay(root, "branch-1", snapshot(), provenance())))
		await saveBranchProvenance(root, "branch-2", provenance())
		await expect(saveBranchReplay(root, "branch-2", snapshot(), provenance())).rejects.toThrow("collision")
		expect(await readBranchProvenance(root, "branch-2")).toEqual(provenance())
	})
})

describe("branch command artifact copying", () => {
	it("streams binary and empty artifacts, ignores unrelated files, and never shares source inodes", async () => {
		const content = Buffer.alloc(200_001, 0xab)
		const source = await writeArtifact("task-1", "cmd-123.txt", content)
		await writeArtifact("task-1", "cmd-456.txt", "")
		await writeArtifact("task-1", "unrelated.txt", "ignore")
		await copyBranchCommandArtifacts(root, "task-1", "branch-1")
		expect(await fs.readFile(artifactPath("branch-1"))).toEqual(content)
		expect((await fs.stat(artifactPath("branch-1"))).ino).not.toBe((await fs.stat(source)).ino)
		expect((await fs.readdir(path.dirname(artifactPath("branch-1")))).sort()).toEqual([
			"cmd-123.txt",
			"cmd-456.txt",
		])
		await fs.writeFile(source, "source changed")
		expect(await fs.readFile(artifactPath("branch-1"))).toEqual(content)
	})

	it("accepts missing source directories without creating destination directories", async () => {
		await copyBranchCommandArtifacts(root, "task-1", "branch-1")
		expect(await fs.readdir(root)).toEqual([])
	})

	it.each(["../escape", "a/b", "a\\b", "CON", ""])("rejects unsafe task identity %j", async (id) => {
		await expect(copyBranchCommandArtifacts(root, id, "branch-1")).rejects.toThrow()
		await expect(copyBranchCommandArtifacts(root, "task-1", id)).rejects.toThrow()
		await expect(copyBranchCommandArtifacts("relative", "task-1", "branch-1")).rejects.toThrow("absolute")
		expect(await fs.readdir(root)).toEqual([])
	})

	it.each(["cmd-bad.txt", "cmd-123.json", "cmd-123.txt.bak", `cmd-${"1".repeat(125)}.txt`])(
		"rejects malformed artifact %s",
		async (name) => {
			await writeArtifact("task-1", name)
			await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("filename")
		},
	)

	it.each(["source-file", "source-directory", "destination-file", "destination-directory"])(
		"rejects %s symlinks",
		async (kind) => {
			await writeArtifact()
			const target = kind.startsWith("source") ? "task-1" : "branch-1"
			const location = kind.endsWith("directory") ? path.dirname(artifactPath(target)) : artifactPath(target)
			await fs.mkdir(path.dirname(location), { recursive: true })
			await fs.rm(location, { force: true, recursive: true })
			const outside = path.join(root, "outside")
			if (kind.endsWith("directory")) await fs.mkdir(outside)
			else await fs.writeFile(outside, "outside")
			await fs.symlink(outside, location, kind.endsWith("directory") ? "dir" : "file")
			await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("symlinks")
		},
	)

	it.each(["task-1", "branch-1"])("rejects non-regular artifact files in %s", async (task) => {
		await writeArtifact()
		await fs.rm(artifactPath(task), { force: true })
		await fs.mkdir(artifactPath(task), { recursive: true })
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("regular")
	})

	it("bounds per-file and aggregate bytes before copying sparse files", async () => {
		const file = await writeArtifact()
		await fs.truncate(file, BRANCH_COMMAND_ARTIFACT_LIMITS.maxFileBytes + 1)
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("size limit")
		await fs.truncate(file, BRANCH_COMMAND_ARTIFACT_LIMITS.maxFileBytes)
		for (let index = 0; index < 4; index++) {
			await fs.truncate(
				await writeArtifact("task-1", `cmd-${index}.txt`),
				BRANCH_COMMAND_ARTIFACT_LIMITS.maxFileBytes,
			)
		}
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("copy limit")
		expect(await fs.readdir(path.join(root, "tasks"))).toEqual(["task-1"])
	})

	it("bounds the number of artifacts", async () => {
		for (let index = 0; index <= BRANCH_COMMAND_ARTIFACT_LIMITS.maxFiles; index++) {
			await writeArtifact("task-1", `cmd-${index}.txt`, "")
		}
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("copy limit")
	})

	it("bounds directory enumeration even when every entry is unrelated", async () => {
		let visited = 0
		let closed = false
		vi.spyOn(fs, "opendir").mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				try {
					while (true) {
						visited++
						yield { name: "unrelated.txt" }
					}
				} finally {
					closed = true
				}
			},
		} as any)
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("entry limit")
		expect(visited).toBe(BRANCH_COMMAND_ARTIFACT_LIMITS.maxDirectoryEntries + 1)
		expect(closed).toBe(true)
	})

	it("rejects source growth during a bounded read and removes the incomplete staging file", async () => {
		const source = await writeArtifact("task-1", "cmd-123.txt", Buffer.alloc(200_000, 0x61))
		const open = fs.open
		let changed = false
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args)
			if (String(args[0]) === source) {
				const read = handle.read.bind(handle)
				vi.spyOn(handle, "read").mockImplementation((async (...readArgs: any[]) => {
					expect(readArgs[2]).toBeLessThanOrEqual(64 * 1024)
					const result = await (read as any)(...readArgs)
					if (!changed) {
						changed = true
						await fs.appendFile(source, "growth")
					}
					return result
				}) as typeof handle.read)
			}
			return handle
		})
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("changed")
		expect(await fs.readdir(path.dirname(artifactPath("branch-1")))).toEqual([])
	})

	it("publishes one winner for concurrent different artifact bytes", async () => {
		await writeArtifact("task-1", "cmd-123.txt", "first")
		await writeArtifact("task-2", "cmd-123.txt", "second")
		const outcomes = await Promise.allSettled([
			copyBranchCommandArtifacts(root, "task-1", "branch-1"),
			copyBranchCommandArtifacts(root, "task-2", "branch-1"),
		])
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
		const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult
		expect(rejected.reason.message).toContain("collision")
		expect(await fs.readFile(artifactPath("branch-1"), "utf8")).toBe(
			outcomes[0].status === "fulfilled" ? "first" : "second",
		)
		expect(await fs.readdir(path.dirname(artifactPath("branch-1")))).toEqual(["cmd-123.txt"])
	})

	it("does not fall back to an overwrite when atomic publication is unavailable", async () => {
		await writeArtifact()
		vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" }))
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("hard links unavailable")
		expect(await fs.readdir(path.dirname(artifactPath("branch-1")))).toEqual([])
	})

	it.skipIf(process.platform === "win32")(
		"syncs each artifact and all ancestors on initial publication and retry",
		async () => {
			await writeArtifact()
			const synced: string[] = []
			const open = fs.open
			vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args)
				const sync = handle.sync.bind(handle)
				vi.spyOn(handle, "sync").mockImplementation(async () => {
					synced.push(String(args[0]))
					await sync()
				})
				return handle
			})
			for (let retry = 0; retry < 2; retry++) {
				synced.length = 0
				await copyBranchCommandArtifacts(root, "task-1", "branch-1")
				expect(synced[0]).toMatch(/\.pending-.*\.tmp$/)
				expect(synced.slice(1)).toEqual([
					artifactPath("branch-1"),
					path.dirname(artifactPath("branch-1")),
					path.join(root, "tasks/branch-1"),
					path.join(root, "tasks"),
					root,
				])
			}
		},
	)

	it("verifies identical retries and rejects differing bytes without overwrite or pending files", async () => {
		await writeArtifact()
		await copyBranchCommandArtifacts(root, "task-1", "branch-1")
		const inode = (await fs.stat(artifactPath("branch-1"))).ino
		await copyBranchCommandArtifacts(root, "task-1", "branch-1")
		expect((await fs.stat(artifactPath("branch-1"))).ino).toBe(inode)
		await writeArtifact("task-1", "cmd-123.txt", "different")
		await expect(copyBranchCommandArtifacts(root, "task-1", "branch-1")).rejects.toThrow("collision")
		expect(await fs.readFile(artifactPath("branch-1"), "utf8")).toBe("command output")
		expect(await fs.readdir(path.dirname(artifactPath("branch-1")))).toEqual(["cmd-123.txt"])
	})

	it.skipIf(process.platform === "win32")(
		"surfaces directory sync failure on publication and identical retry",
		async () => {
			await writeArtifact()
			const open = fs.open
			const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
				const handle = await open(...args)
				if (String(args[0]) === path.dirname(artifactPath("branch-1"))) {
					vi.spyOn(handle, "sync").mockRejectedValue(new Error("directory sync failed"))
				}
				return handle
			})
			await expect(saveBranchReplay(root, "branch-1", snapshot(), provenance())).rejects.toThrow(
				"directory sync failed",
			)
			await expect(saveBranchReplay(root, "branch-1", snapshot(), provenance())).rejects.toThrow(
				"directory sync failed",
			)
			expect(await readBranchProvenance(root, "branch-1")).toBeUndefined()
			spy.mockRestore()
			await saveBranchReplay(root, "branch-1", snapshot(), provenance())
		},
	)
})
