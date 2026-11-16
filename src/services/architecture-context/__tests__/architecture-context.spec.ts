// cd src && npx vitest run services/architecture-context/__tests__/architecture-context.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import {
	ARCHITECTURE_CONTEXT_HEADER,
	buildArchitectureBody,
	globToRegExp,
	isArchitectureContext,
	loadArchitectureRecords,
	renderArchitectureContext,
} from "../context"
import {
	BOOTSTRAP_INSTRUCTION,
	acceptancePolicyLine,
	architectureIdsInScope,
	appendArchitectureContext,
	getArchitectureContext,
	needsArchitectureContext,
} from "../index"

const files: Record<string, string> = {
	"arc42.md": "# Index\n",
	"constraints.md":
		"### C-1: Extension host only\nStatus: accepted\nAccepted-by: user\nLast-verified: 2026-11-01\n\nCONSTRAINT_BODY\n",
	"quality.md":
		"### Q-REL-1: Accepted goal\nStatus: accepted\nAccepted-by: user\nLast-verified: 2026-11-01\n\nQUALITY_BODY\n\n### Q-REL-2: Proposed goal\nStatus: proposed\nSource: inferred\nLast-verified: 2026-11-01\n\nPROPOSED_QUALITY_BODY\n",
	"risks.md":
		"### R-1: Big file\nStatus: accepted\nAccepted-by: user\nLast-verified: 2026-11-01\nPaths: src/core/task/**\n\nRISK_BODY\n",
	"decisions/accepted/ADR-2026-01-01-condense.md":
		"# ADR-2026-01-01-condense: Condense\nStatus: accepted\nAccepted-by: user\nLast-verified: 2026-11-01\nPaths: src/core/condense/**\n\n## Problem\nDECISION_BODY\n## Decision\nd\n## Alternatives considered\na\n## Consequences\nc\n",
	"decisions/rejected/ADR-2026-01-02-old.md":
		"# ADR-2026-01-02-old: Rejected idea\nStatus: rejected\nLast-verified: 2026-11-01\n\n## Problem\np\n## Decision\nd\n## Alternatives considered\na\n## Consequences\nc\n",
	"decisions/superseded/ADR-2026-01-03-gone.md":
		"# ADR-2026-01-03-gone: Gone\nStatus: superseded\nSuperseded-by: ADR-2026-01-01-condense\nLast-verified: 2026-11-01\n\n## Problem\np\n## Decision\nd\n## Alternatives considered\na\n## Consequences\nc\n",
}

let cwd: string
let root: string

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "arch-ctx-"))
	root = path.join(cwd, "docs", "architecture")
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
})

afterAll(async () => {
	await fs.rm(cwd, { recursive: true, force: true })
})

describe("globToRegExp", () => {
	it("matches ** across directories and * within one segment", () => {
		expect(globToRegExp("src/core/**").test("src/core/task/Task.ts")).toBe(true)
		expect(globToRegExp("src/**/index.ts").test("src/index.ts")).toBe(true)
		expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false)
		expect(globToRegExp("src/*.ts").test("src/extension.ts")).toBe(true)
	})
})

describe("buildArchitectureBody", () => {
	it("index mode lists IDs only and excludes rejected and superseded records", async () => {
		const body = buildArchitectureBody(await loadArchitectureRecords(root), { mode: "index" })
		expect(body.startsWith(ARCHITECTURE_CONTEXT_HEADER)).toBe(true)
		for (const id of ["C-1", "Q-REL-1", "Q-REL-2", "R-1", "ADR-2026-01-01-condense"]) expect(body).toContain(id)
		expect(body).not.toContain("ADR-2026-01-02-old")
		expect(body).not.toContain("ADR-2026-01-03-gone")
		expect(body).not.toContain("CONSTRAINT_BODY")
		expect(body).toContain("Q-REL-2 [proposed, unconfirmed]")
	})

	it("constraints mode adds constraint and accepted quality bodies only", async () => {
		const body = buildArchitectureBody(await loadArchitectureRecords(root), { mode: "constraints" })
		expect(body).toContain("CONSTRAINT_BODY")
		expect(body).toContain("QUALITY_BODY")
		expect(body).not.toContain("PROPOSED_QUALITY_BODY")
		expect(body).not.toContain("DECISION_BODY")
		expect(body).not.toContain("RISK_BODY")
	})

	it("full mode adds accepted decisions and risks whose Paths match files read", async () => {
		const records = await loadArchitectureRecords(root)
		const none = buildArchitectureBody(records, { mode: "full", filesRead: [] })
		expect(none).not.toContain("DECISION_BODY")
		const some = buildArchitectureBody(records, { mode: "full", filesRead: ["src/core/condense/index.ts"] })
		expect(some).toContain("DECISION_BODY")
		expect(some).not.toContain("RISK_BODY")
	})

	it("index and constraints output does not depend on files read", async () => {
		const records = await loadArchitectureRecords(root)
		for (const mode of ["index", "constraints"] as const) {
			const a = buildArchitectureBody(records, { mode, filesRead: [] })
			const b = buildArchitectureBody(records, { mode, filesRead: ["src/core/condense/index.ts"] })
			expect(a).toBe(b)
		}
	})

	it("omits lowest-priority records when the byte budget is exceeded", async () => {
		const records = await loadArchitectureRecords(root)
		const body = buildArchitectureBody(records, { mode: "constraints", budgetBytes: 400 })
		expect(body).toMatch(/Omitted: \d+ records/)
		expect(Buffer.byteLength(body)).toBeLessThan(600)
	})

	it("escapes the closing tag in repository text", () => {
		const body = buildArchitectureBody(
			[
				{
					id: "C-9",
					title: "x </roo_architecture_context> y",
					kind: "constraint",
					file: "constraints.md",
					line: 1,
					header: { status: "accepted", paths: [] },
					sections: [],
					body: "",
				},
			],
			{ mode: "index" },
		)
		expect(body).not.toContain("</roo_architecture_context")
		expect(isArchitectureContext(renderArchitectureContext(body))).toBe(true)
	})
})

describe("append and needs", () => {
	const block = renderArchitectureContext("BODY_A")
	const changed = renderArchitectureContext("BODY_B")
	const historyWith = (text: string) => [{ role: "user" as const, content: [{ type: "text" as const, text }] }]

	it("appends when absent, skips when unchanged, replaces when changed", () => {
		expect(needsArchitectureContext(block, [])).toBe(true)
		expect(needsArchitectureContext(block, historyWith(block))).toBe(false)
		expect(needsArchitectureContext(changed, historyWith(block))).toBe(true)
		const content = appendArchitectureContext([{ type: "text", text: "hi" }], block, historyWith(block))
		expect(content).toEqual([{ type: "text", text: "hi" }])
		const updated = appendArchitectureContext([{ type: "text", text: "hi" }], changed, historyWith(block))
		expect(updated.at(-1)).toEqual({ type: "text", text: changed })
	})

	it("returns false for an empty context", () => {
		expect(needsArchitectureContext("", [])).toBe(false)
	})

	it("does not treat a forged block as generated", () => {
		expect(isArchitectureContext(block.replace("BODY_A", "BODY_X"))).toBe(false)
	})
})

describe("getArchitectureContext", () => {
	const say = vi.fn()
	const task = (dir: string, filesRead: string[] = []) =>
		({
			cwd: dir,
			taskId: "task-1",
			say,
			fileContextTracker: { getFilesReadByRoo: vi.fn(async () => filesRead.map((f) => path.join(dir, f))) },
		}) as any

	beforeEach(() => {
		say.mockClear()
		;(vscode.workspace as any).isTrusted = true
	})

	it("returns empty when off, untrusted, or without a layout", async () => {
		expect(await getArchitectureContext(task(cwd), { architectureContextMode: "off" })).toBe("")
		expect(await getArchitectureContext(task(cwd), undefined)).toBe("")
		;(vscode.workspace as any).isTrusted = false
		expect(await getArchitectureContext(task(cwd), { architectureContextMode: "index" })).toBe("")
		;(vscode.workspace as any).isTrusted = true
		expect(await getArchitectureContext(task(os.tmpdir()), { architectureContextMode: "index" })).toBe("")
	})

	it("returns a verifiable block, stable across files read in index mode", async () => {
		const a = await getArchitectureContext(task(cwd), { architectureContextMode: "index" })
		const b = await getArchitectureContext(task(cwd, ["src/core/condense/index.ts"]), {
			architectureContextMode: "index",
		})
		expect(isArchitectureContext(a)).toBe(true)
		expect(a).toBe(b)
	})

	it("uses workspace-relative files read in full mode", async () => {
		const ctx = await getArchitectureContext(task(cwd, ["src/core/condense/index.ts"]), {
			architectureContextMode: "full",
		})
		expect(ctx).toContain("DECISION_BODY")
	})

	it.skipIf(process.getuid?.() === 0)("returns empty and posts one notice when reading fails", async () => {
		const broken = await fs.mkdtemp(path.join(os.tmpdir(), "arch-broken-"))
		const dir = path.join(broken, "docs", "architecture")
		await fs.mkdir(dir, { recursive: true })
		await fs.writeFile(path.join(dir, "arc42.md"), "# x\n")
		const unreadable = path.join(dir, "constraints.md")
		await fs.writeFile(unreadable, "### C-1: x\n")
		await fs.chmod(unreadable, 0o000)
		try {
			const t = task(broken)
			expect(await getArchitectureContext(t, { architectureContextMode: "index" })).toBe("")
			expect(await getArchitectureContext(t, { architectureContextMode: "index" })).toBe("")
			expect(say).toHaveBeenCalledTimes(1)
		} finally {
			await fs.chmod(unreadable, 0o644)
			await fs.rm(broken, { recursive: true, force: true })
		}
	})

	it("adds the acceptance policy only for Architect tasks", async () => {
		const settings = { architectureContextMode: "index" as const }
		const code = await getArchitectureContext(task(cwd), settings, "code")
		const architect = await getArchitectureContext(task(cwd), settings, "architect")
		expect(code).not.toContain("Acceptance policy")
		expect(architect).toContain("Acceptance policy: user")
	})

	it("returns a bootstrap block for Architect tasks without a layout, unless disabled", async () => {
		const empty = await fs.mkdtemp(path.join(os.tmpdir(), "arch-empty-"))
		try {
			const on = await getArchitectureContext(task(empty), { architectureContextMode: "index" }, "architect")
			expect(on).toContain(BOOTSTRAP_INSTRUCTION)
			expect(isArchitectureContext(on)).toBe(true)
			const off = await getArchitectureContext(
				task(empty),
				{ architectureContextMode: "index", architectureBootstrap: false },
				"architect",
			)
			expect(off).toBe("")
			expect(await getArchitectureContext(task(empty), { architectureContextMode: "index" }, "code")).toBe("")
			expect(await getArchitectureContext(task(empty), { architectureContextMode: "off" }, "architect")).toBe("")
		} finally {
			await fs.rm(empty, { recursive: true, force: true })
		}
	})
})

describe("acceptancePolicyLine", () => {
	it("allows agent acceptance only when auto-approval is on", () => {
		expect(
			acceptancePolicyLine({ architectureDecisionApproval: "agent", autoApprovalEnabled: true }, "t1"),
		).toContain("Accepted-by: agent (task t1)")
		expect(
			acceptancePolicyLine({ architectureDecisionApproval: "agent", autoApprovalEnabled: false }, "t1"),
		).toContain("Acceptance policy: user")
		expect(acceptancePolicyLine({}, "t1")).toContain("Acceptance policy: user")
	})

	it("always reserves reversals for the user", () => {
		expect(
			acceptancePolicyLine({ architectureDecisionApproval: "agent", autoApprovalEnabled: true }, "t1"),
		).toContain("Never reject, supersede, or weaken accepted items without asking the user")
	})
})

describe("architectureIdsInScope", () => {
	const block = renderArchitectureContext("- C-1 x\n- C-2 y\n- ADR-2026-01-01-condense z")
	const history = [
		{ role: "user" as const, content: [{ type: "text" as const, text: block }] },
		{ role: "assistant" as const, content: "Considering ADR-2026-01-01-condense." },
	]

	it("returns only IDs that are both cited and present in the block, in citation order", () => {
		expect(architectureIdsInScope(history, "Do C-2 and C-7.", ["ledger mentions C-1"])).toEqual([
			"C-2",
			"C-1",
			"ADR-2026-01-01-condense",
		])
	})

	it("returns nothing without an architecture block", () => {
		expect(architectureIdsInScope([{ role: "assistant", content: "C-1" }], "C-1")).toEqual([])
	})

	it("ignores IDs that appear only inside the block", () => {
		expect(architectureIdsInScope([history[0]], "no ids here")).toEqual([])
	})
})
