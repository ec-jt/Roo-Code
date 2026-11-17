import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { checkArchitectureDocs } from "../check"
import { extractCitedIds, parseArchitectureFile } from "../parse"

const NOW = new Date("2026-11-13T00:00:00Z")

const ACCEPTED_ADR = `# ADR-2026-01-01-example: Example
Status: accepted
Accepted-by: user
Last-verified: 2026-11-01
Paths: src/**

## Problem
p
## Decision
d
## Alternatives considered
a
## Consequences
c
`

const PROPOSED_ADR = `# ADR-2026-01-02-other: Other
Status: proposed
Source: reconstructed
Last-verified: 2026-11-01

## Problem
p
## Proposal
p
## Alternatives considered
a
## Acceptance criteria
a
## Risks
r
`

const CONSTRAINTS = `# Constraints

### C-1: One
Status: accepted
Accepted-by: user
Last-verified: 2026-11-01

Text citing [ADR-2026-01-01-example](decisions/accepted/ADR-2026-01-01-example.md).
`

async function makeTree(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "arch-check-"))
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel)
		await fs.mkdir(path.dirname(full), { recursive: true })
		await fs.writeFile(full, content)
	}
	return root
}

function base(overrides: Record<string, string | undefined> = {}): Record<string, string> {
	const files: Record<string, string | undefined> = {
		"arc42.md": "# Index\n\n[Constraints](constraints.md)\n",
		"constraints.md": CONSTRAINTS,
		"decisions/accepted/ADR-2026-01-01-example.md": ACCEPTED_ADR,
		"decisions/proposed/ADR-2026-01-02-other.md": PROPOSED_ADR,
		...overrides,
	}
	return Object.fromEntries(Object.entries(files).filter(([, v]) => v !== undefined)) as Record<string, string>
}

const roots: string[] = []
async function run(files: Record<string, string>, approval: "user" | "agent" = "user") {
	const root = await makeTree(files)
	roots.push(root)
	return checkArchitectureDocs(root, { approval, now: NOW })
}

afterAll(async () => {
	await Promise.all(roots.map((r) => fs.rm(r, { recursive: true, force: true })))
})

const messages = (result: Awaited<ReturnType<typeof run>>, severity: "error" | "warning") =>
	result.issues.filter((i) => i.severity === severity).map((i) => i.message)

describe("parseArchitectureFile", () => {
	it("parses decision header, paths, and sections", () => {
		const [record] = parseArchitectureFile("decisions/accepted/ADR-2026-01-01-example.md", ACCEPTED_ADR)
		expect(record.id).toBe("ADR-2026-01-01-example")
		expect(record.kind).toBe("decision")
		expect(record.header.status).toBe("accepted")
		expect(record.header.paths).toEqual(["src/**"])
		expect(record.sections).toEqual(["Problem", "Decision", "Alternatives considered", "Consequences"])
	})

	it("parses multiple entries and ignores fenced examples", () => {
		const text = "### C-1: A\nStatus: accepted\n\n```\n### C-9: Example\n```\n\n### C-2: B\nStatus: proposed\n"
		const records = parseArchitectureFile("constraints.md", text)
		expect(records.map((r) => r.id)).toEqual(["C-1", "C-2"])
		expect(records[1].header.status).toBe("proposed")
	})

	it("extracts cited IDs outside code", () => {
		expect(extractCitedIds("See C-1 and Q-REL-2, not `C-9`.").sort()).toEqual(["C-1", "Q-REL-2"])
	})
})

describe("checkArchitectureDocs", () => {
	it("passes a valid tree with only Source warnings", async () => {
		const result = await run(base())
		expect(result.errorCount).toBe(0)
		expect(messages(result, "warning")).toEqual([expect.stringContaining("Source: reconstructed")])
	})

	it("fails without the index", async () => {
		const result = await run(base({ "arc42.md": undefined }))
		expect(result.errorCount).toBe(1)
	})

	it("reports broken links", async () => {
		const result = await run(base({ "arc42.md": "[x](missing.md)\n" }))
		expect(messages(result, "error")).toContainEqual(expect.stringContaining("Broken link: missing.md"))
	})

	it("reports duplicate IDs", async () => {
		const result = await run(base({ "risks.md": "### C-1: Dup\nStatus: proposed\nLast-verified: 2026-11-01\n" }))
		expect(messages(result, "error")).toContainEqual(expect.stringContaining("Duplicate ID C-1"))
	})

	it("reports unresolved cited IDs", async () => {
		const result = await run(base({ "arc42.md": "Depends on R-7.\n" }))
		expect(messages(result, "error")).toContainEqual("Cited ID R-7 does not resolve")
	})

	it("reports folder and status mismatch", async () => {
		const result = await run(
			base({
				"decisions/accepted/ADR-2026-01-02-other.md": PROPOSED_ADR,
				"decisions/proposed/ADR-2026-01-02-other.md": undefined,
			}),
		)
		expect(messages(result, "error")).toContainEqual(expect.stringContaining('folder "accepted" does not match'))
	})

	it("reports missing required sections", async () => {
		const result = await run(
			base({ "decisions/proposed/ADR-2026-01-02-other.md": PROPOSED_ADR.replace("## Risks\nr\n", "") }),
		)
		expect(messages(result, "error")).toContainEqual(expect.stringContaining('missing section "## Risks"'))
	})

	it("requires Accepted-by on accepted records", async () => {
		const result = await run(
			base({ "decisions/accepted/ADR-2026-01-01-example.md": ACCEPTED_ADR.replace("Accepted-by: user\n", "") }),
		)
		expect(messages(result, "error")).toContainEqual(expect.stringContaining("need Accepted-by"))
	})

	it("rejects agent acceptance with --approval user and allows it with agent", async () => {
		const agent = base({
			"decisions/accepted/ADR-2026-01-01-example.md": ACCEPTED_ADR.replace(
				"Accepted-by: user",
				"Accepted-by: agent (task abc-123)",
			),
		})
		const asUser = await run(agent, "user")
		expect(messages(asUser, "error")).toContainEqual(expect.stringContaining("not allowed with --approval user"))
		const asAgent = await run(agent, "agent")
		expect(asAgent.errorCount).toBe(0)
	})

	it("requires a resolving Superseded-by", async () => {
		const superseded = ACCEPTED_ADR.replace("Status: accepted", "Status: superseded")
		const missing = await run(
			base({
				"decisions/superseded/ADR-2026-01-01-example.md": superseded,
				"decisions/accepted/ADR-2026-01-01-example.md": undefined,
				"constraints.md": CONSTRAINTS.replace(/Text citing.*\n/, ""),
			}),
		)
		expect(messages(missing, "error")).toContainEqual(expect.stringContaining("need Superseded-by"))

		const dangling = await run(
			base({
				"decisions/superseded/ADR-2026-01-01-example.md": superseded.replace(
					"Last-verified",
					"Superseded-by: ADR-2026-09-09-none\nLast-verified",
				),
				"decisions/accepted/ADR-2026-01-01-example.md": undefined,
				"constraints.md": CONSTRAINTS.replace(/Text citing.*\n/, ""),
			}),
		)
		expect(messages(dangling, "error")).toContainEqual(
			expect.stringContaining("Superseded-by ADR-2026-09-09-none does not resolve"),
		)
	})

	it("warns when Last-verified is older than 180 days", async () => {
		const result = await run(
			base({ "constraints.md": CONSTRAINTS.replace("Last-verified: 2026-11-01", "Last-verified: 2026-01-01") }),
		)
		expect(result.errorCount).toBe(0)
		expect(messages(result, "warning")).toContainEqual(expect.stringContaining("older than 180 days"))
	})
})

describe("parseArchitectureFile Paths", () => {
	it("removes Markdown escapes added by formatters", () => {
		const [record] = parseArchitectureFile(
			"risks.md",
			"### R-9: Example\nStatus: proposed\nLast-verified: 2026-11-01\nPaths: src/core/\\*\\*, src/a\\_b.ts, src/x.ts\n\nText.\n",
		)
		expect(record.header.paths).toEqual(["src/core/**", "src/a_b.ts", "src/x.ts"])
	})
})
