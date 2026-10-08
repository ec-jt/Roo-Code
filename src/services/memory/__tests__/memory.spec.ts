import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { MEMORY_LIMITS, MemoryStore, assertNoSecrets, resolveMemoryProject, type MemoryInput } from "../index"
import { serializeRecord } from "../records"

const exec = promisify(execFile)
const authorize = async () => undefined
const input: MemoryInput = {
	name: "Review practice",
	description: "Use focused checks",
	type: "feedback",
	body: "Run focused checks because broad runs are expensive.",
}
let temp: string
let store: MemoryStore

beforeEach(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "roo-memory-"))
	const folder = path.join(temp, "workspace")
	await fs.mkdir(folder)
	store = new MemoryStore(path.join(temp, "storage"), await resolveMemoryProject(folder))
})

afterEach(async () => {
	vi.unstubAllEnvs()
	await fs.rm(temp, { recursive: true, force: true })
})

async function enable(target = store, personalRecall = false) {
	return target.setConsent({ enabled: true, personalRecall }, (await target.getConsent()).revision)
}

async function create(target = store, scope: "project" | "personal" = "project", value = input) {
	return target.upsert(scope, value, { expectedRevision: null, authorize })
}

async function manualTopic(body = input.body, name = input.name, description = input.description) {
	const id = randomUUID()
	const raw = serializeRecord({
		...input,
		id,
		name,
		description,
		body,
		createdAt: "2026-01-01T00:00:00.000Z",
		modifiedAt: "2026-01-01T00:00:00.000Z",
	})
	await fs.writeFile(store.getRecordPath("project", id), raw)
	return id
}

describe("MemoryStore", () => {
	it("keeps disabled reads and rejected writes side-effect free", async () => {
		expect(await store.getConsent()).toEqual({ enabled: false, personalRecall: false, revision: "disabled" })
		expect((await store.list("project")).records).toEqual([])
		expect(await store.read("personal", randomUUID())).toBeUndefined()
		expect((await store.getRecallIndex()).text).toBe("")
		await expect(create()).rejects.toMatchObject({ code: "DISABLED" })
		await expect(fs.stat(store.storageRoot)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("creates, updates, rereads and searches records with exact revisions", async () => {
		await enable()
		const first = await create()
		expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(await store.read("project", first.id)).toEqual(first)
		const changed = await store.upsert(
			"project",
			{ ...input, id: first.id, body: "Updated reason" },
			{ expectedRevision: first.revision, authorize },
		)
		expect(changed.createdAt).toBe(first.createdAt)
		expect(changed.revision).not.toBe(first.revision)
		expect((await store.list("project", "updated")).records).toEqual([changed])
		expect((await store.list("project", "not present")).records).toEqual([])
		expect((await store.getRecallIndex()).count).toBe(1)
		await expect(
			store.upsert("project", { ...input, id: first.id }, { expectedRevision: first.revision, authorize }),
		).rejects.toMatchObject({ code: "CONFLICT" })
	})

	it("serializes competing store instances and rejects one stale CAS update", async () => {
		await enable()
		const initial = await create()
		const other = new MemoryStore(store.storageRoot, store.project)
		const results = await Promise.allSettled(
			[store, other].map((target, i) =>
				target.upsert(
					"project",
					{ ...input, id: initial.id, body: `Change ${i}` },
					{ expectedRevision: initial.revision, authorize },
				),
			),
		)
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
	})

	it("revokes a write while its authorization callback is pending, without deadlock", async () => {
		await enable()
		await expect(
			store.upsert("project", input, {
				expectedRevision: null,
				authorize: async () => {
					const consent = await store.getConsent()
					await store.setConsent({ enabled: false, personalRecall: false }, consent.revision)
				},
			}),
		).rejects.toMatchObject({ code: "DISABLED" })
		expect((await store.list("project")).total).toBe(0)
	})

	it("does not replay an operation after disable and re-enable", async () => {
		await enable()
		await expect(
			store.upsert("project", input, {
				expectedRevision: null,
				authorize: async () => {
					await store.setConsent(
						{ enabled: false, personalRecall: false },
						(await store.getConsent()).revision,
					)
					await enable()
				},
			}),
		).rejects.toMatchObject({ code: "DISABLED" })
	})

	it("rejects stale settings and fails closed on malformed consent", async () => {
		await enable()
		await expect(store.setConsent({ enabled: false, personalRecall: false }, "disabled")).rejects.toMatchObject({
			code: "CONFLICT",
		})
		await fs.writeFile(
			path.join(store.storageRoot, "memory", "controls", `${store.project.key}.md`),
			"enabled: yes\n",
		)
		await expect(store.getRecallIndex()).rejects.toMatchObject({ code: "INVALID_CONSENT" })
	})

	it("separates projects and shares personal scope only for explicitly enabled recall", async () => {
		await enable()
		const project = await create()
		const personal = await create(store, "personal", { ...input, name: "Personal preference" })
		const otherRoot = path.join(temp, "other-project")
		await fs.mkdir(otherRoot)
		const other = new MemoryStore(store.storageRoot, await resolveMemoryProject(otherRoot))
		expect(await other.read("project", project.id)).toBeUndefined()
		expect(await other.read("personal", personal.id)).toEqual(personal)
		expect((await store.getRecallIndex()).count).toBe(1)
		await enable(store, true)
		expect((await store.getRecallIndex()).count).toBe(2)
		await enable(other, true)
		expect((await other.getRecallIndex()).count).toBe(1)
	})

	it("detects manual edits and preserves a manually edited index", async () => {
		await enable()
		const record = await create()
		const file = store.getRecordPath("project", record.id)
		await fs.appendFile(file, "\nManual clarification")
		const edited = await store.read("project", record.id)
		expect(edited?.revision).not.toBe(record.revision)
		expect((await store.list("project", "manual clarification")).total).toBe(1)
		await expect(
			store.upsert("project", { ...input, id: record.id }, { expectedRevision: record.revision, authorize }),
		).rejects.toMatchObject({ code: "CONFLICT" })
		const index = path.join(store.getDirectory("project"), "MEMORY.md")
		await fs.writeFile(index, "My manual notes")
		await create(store, "project", { ...input, name: "Another topic" })
		expect(await fs.readFile(index, "utf8")).toBe("My manual notes")
		expect((await store.list("project")).errors).toContainEqual(expect.objectContaining({ code: "INDEX_EDITED" }))
		expect((await store.getRecallIndex()).text).not.toContain("My manual notes")
	})

	it("reconciles from topics after an index is missing or stale", async () => {
		await enable()
		const record = await create()
		await fs.unlink(path.join(store.getDirectory("project"), "MEMORY.md"))
		expect((await store.getRecallIndex()).text).toContain(record.id)
		await create()
		expect(await fs.readFile(path.join(store.getDirectory("project"), "MEMORY.md"), "utf8")).toContain(record.id)
	})

	it("skips malformed metadata, YAML aliases, invalid dates, and manual secrets without deleting them", async () => {
		await enable()
		await fs.mkdir(store.getDirectory("project"), { recursive: true })
		for (const raw of ["no header", "---\nid: &a [*a]\n---\nbody"]) {
			await fs.writeFile(store.getRecordPath("project", randomUUID()), raw)
		}
		const badDate = await manualTopic()
		const datePath = store.getRecordPath("project", badDate)
		await fs.writeFile(datePath, (await fs.readFile(datePath, "utf8")).replaceAll("2026-01-01", "2026-99-01"))
		const secret = await manualTopic()
		await fs.appendFile(store.getRecordPath("project", secret), "\npassword=super-secret-value")
		const list = await store.list("project")
		expect(list.records).toHaveLength(0)
		expect(list.errors).toHaveLength(4)
		await expect(create()).rejects.toMatchObject({ code: "INVALID_STORE" })
		expect(await fs.readFile(datePath, "utf8")).toContain("2026-99-01")
	})

	it("blocks symlinks, hardlinks and FIFOs without hanging", async () => {
		await enable()
		await fs.mkdir(store.getDirectory("project"), { recursive: true })
		const outside = path.join(temp, "outside")
		await fs.writeFile(outside, "outside")
		const symlink = randomUUID()
		const hardlink = randomUUID()
		const fifo = randomUUID()
		await fs.symlink(outside, store.getRecordPath("project", symlink))
		await fs.link(outside, store.getRecordPath("project", hardlink))
		await exec("mkfifo", [store.getRecordPath("project", fifo)], { timeout: 3000 })
		for (const id of [symlink, hardlink, fifo])
			await expect(store.read("project", id)).rejects.toMatchObject({ code: "UNSAFE_FILE" })
		expect((await store.list("project")).errors).toHaveLength(3)
		expect(await fs.readFile(outside, "utf8")).toBe("outside")
	})

	it("rejects linked storage directories and invalid IDs", async () => {
		await fs.symlink(path.join(temp, "workspace"), store.storageRoot)
		await expect(store.getConsent()).rejects.toMatchObject({ code: "UNSAFE_PATH" })
		await expect(store.read("project", "../outside")).rejects.toMatchObject({ code: "INVALID_ID" })
	})

	it("blocks obvious secrets and oversized byte/line payloads", async () => {
		await enable()
		for (const body of [
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			`sk-${"a".repeat(30)}`,
			"Authorization: Bearer abcdefghijklmnop",
			"api_key=synthetic-secret-value",
		]) {
			await expect(create(store, "project", { ...input, body })).rejects.toMatchObject({ code: "SECRET" })
		}
		expect(() => assertNoSecrets("ordinary preference and a URL https://example.com/docs")).not.toThrow()
		await expect(
			create(store, "project", { ...input, body: "x".repeat(MEMORY_LIMITS.topicBytes) }),
		).rejects.toMatchObject({ code: "LIMIT" })
		await expect(
			create(store, "project", { ...input, body: "line\n".repeat(MEMORY_LIMITS.topicLines) }),
		).rejects.toMatchObject({ code: "LIMIT" })
	})

	it("bounds index bytes and lines and exposes omitted records through search", async () => {
		await enable()
		await fs.mkdir(store.getDirectory("project"), { recursive: true })
		for (let i = 0; i < 120; i++) await manualTopic(input.body, `Topic ${i}`, "Long description ".repeat(25))
		const index = await store.getRecallIndex()
		expect(Buffer.byteLength(index.text)).toBeLessThanOrEqual(MEMORY_LIMITS.indexBytes)
		expect(index.count + index.omitted).toBe(120)
		expect(index.omitted).toBeGreaterThan(0)
		expect(index.text.split("\n").length - 1).toBeLessThanOrEqual(200)
		expect((await store.list("project")).omitted).toBe(20)
		expect((await store.list("project", "Topic 119")).total).toBe(1)
		expect((await store.getRecallIndex(0)).omitted).toBe(120)
	})

	it("enforces record-count and total-byte limits", async () => {
		await enable()
		await fs.mkdir(store.getDirectory("project"), { recursive: true })
		for (let i = 0; i < 200; i++) await manualTopic()
		await expect(create()).rejects.toMatchObject({ code: "LIMIT" })
		await fs.rm(store.getDirectory("project"), { recursive: true })
		await fs.mkdir(store.getDirectory("project"))
		for (let i = 0; i < 65; i++) await manualTopic("x".repeat(31 * 1024))
		await expect(create(store, "project", { ...input, body: "x".repeat(31 * 1024) })).rejects.toMatchObject({
			code: "LIMIT",
		})
	})

	it("forgets while disabled, keeps no topic content in tombstones, and blocks resurrection", async () => {
		await enable()
		const record = await create()
		const raw = await fs.readFile(store.getRecordPath("project", record.id), "utf8")
		await store.setConsent({ enabled: false, personalRecall: false }, (await store.getConsent()).revision)
		await store.delete("project", record.id, { expectedRevision: record.revision, authorize })
		expect(await store.read("project", record.id)).toBeUndefined()
		const tombstones = await fs.readFile(path.join(store.getDirectory("project"), "forgotten.txt"), "utf8")
		expect(tombstones).toBe(`${record.id}\n`)
		await enable()
		await expect(
			store.upsert("project", { ...input, id: record.id }, { expectedRevision: record.revision, authorize }),
		).rejects.toMatchObject({ code: "CONFLICT" })
		await fs.writeFile(store.getRecordPath("project", record.id), raw)
		expect((await store.getRecallIndex()).count).toBe(0)
		expect((await store.list("project")).errors).toContainEqual(expect.objectContaining({ code: "FORGOTTEN" }))
	})

	it("requires an inventory revision for clear and rechecks after authorization", async () => {
		await enable()
		const record = await create()
		const list = await store.list("project")
		await expect(store.clear("project", { expectedRevision: "stale", authorize })).rejects.toMatchObject({
			code: "CONFLICT",
		})
		await expect(
			store.clear("project", {
				expectedRevision: list.revision,
				authorize: async () => {
					await fs.appendFile(store.getRecordPath("project", record.id), "\nEdit")
				},
			}),
		).rejects.toMatchObject({ code: "CONFLICT" })
		await store.clear("project", { expectedRevision: (await store.list("project")).revision, authorize })
		expect((await store.list("project")).total).toBe(0)
	})

	it("can clear an empty uninitialized scope using its observed revision", async () => {
		const inventory = await store.list("project")
		await store.clear("project", { expectedRevision: inventory.revision, authorize })
		expect((await store.list("project")).records).toEqual([])
	})

	it("does not commit when authorization fails or manually changes the topic", async () => {
		await enable()
		await expect(
			store.upsert("project", input, {
				expectedRevision: null,
				authorize: async () => {
					throw new Error("denied")
				},
			}),
		).rejects.toThrow("denied")
		const record = await create()
		await expect(
			store.upsert(
				"project",
				{ ...input, id: record.id },
				{
					expectedRevision: record.revision,
					authorize: async () => {
						await fs.appendFile(store.getRecordPath("project", record.id), "\nManual edit")
					},
				},
			),
		).rejects.toMatchObject({ code: "CONFLICT" })
		expect((await store.read("project", record.id))?.body).toContain("Manual edit")
	})
})

describe("resolveMemoryProject", () => {
	const git = (cwd: string, args: string[]) => exec("git", args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 })

	it("shares linked worktrees/subdirectories but separates clones, nested repositories and submodules", async () => {
		const repo = path.join(temp, "repo")
		await fs.mkdir(repo)
		await git(repo, ["init"])
		await git(repo, [
			"-c",
			"user.name=Memory Test",
			"-c",
			"user.email=memory@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"Initial",
		])
		const worktree = path.join(temp, "worktree")
		await git(repo, ["worktree", "add", "-b", "memory-test", worktree])
		const subdir = path.join(repo, "subdir")
		await fs.mkdir(subdir)
		const identity = await resolveMemoryProject(repo)
		expect((await resolveMemoryProject(worktree)).key).toBe(identity.key)
		expect((await resolveMemoryProject(subdir)).key).toBe(identity.key)
		const clone = path.join(temp, "clone")
		await git(temp, ["clone", "--no-hardlinks", repo, clone])
		expect((await resolveMemoryProject(clone)).key).not.toBe(identity.key)
		const nested = path.join(repo, "nested")
		await fs.mkdir(nested)
		await git(nested, ["init"])
		expect((await resolveMemoryProject(nested)).key).not.toBe(identity.key)
		await git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", repo, "module"])
		expect((await resolveMemoryProject(path.join(repo, "module"))).key).not.toBe(identity.key)
		vi.stubEnv("GIT_DIR", path.join(clone, ".git"))
		expect((await resolveMemoryProject(repo)).key).toBe(identity.key)
	})

	it("canonicalizes folder aliases without selecting a non-Git ancestor", async () => {
		const folder = path.join(temp, "workspace")
		const alias = path.join(temp, "alias")
		await fs.symlink(folder, alias)
		expect(await resolveMemoryProject(alias)).toEqual(await resolveMemoryProject(folder))
		const nested = path.join(folder, "nested")
		await fs.mkdir(nested)
		expect((await resolveMemoryProject(nested)).key).not.toBe((await resolveMemoryProject(folder)).key)
	})
})
