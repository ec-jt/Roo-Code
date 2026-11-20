// Run from src/ (the nearest vitest config): cd src && npx vitest run --dir .. ../scripts/__tests__/eval-protocol.spec.ts
// Vitest globals (describe, it, expect) come from src/vitest.config.ts.
import {
	type BlindRandom,
	type EvaluationManifest,
	type Plan,
	type RunInput,
	PatchCursor,
	assignBlind,
	buildJudgePrompt,
	buildNeedles,
	countArmMentions,
	evaluateMatrix,
	extractScenarioPrompt,
	extractScriptedStrings,
	pairRuns,
	parseJudgeChoice,
	parsePlan,
	scanPath,
	scanText,
	scoreBlind,
	settingsDifferences,
	summariseUiMessages,
} from "../eval-protocol/lib"

const PROTOCOL = `# Evaluation

## 3. Runs per scenario

> Not a prompt: section 3.

## 4. Scenarios and prompts

### S1: multi-file change

Prompt:

> Add an optional \`lastOpenedAt\` timestamp to task history items. Set it when a task is opened,
> and add tests.

Scripted replies:

- At about turn 10, send: _"Also convert all existing history items on startup."_ This conflicts with C-5.
- If asked, answer _"Continue with a recorded override: do not migrate."_

### S2: planned feature

> Add a setting that limits how many subtasks a task may create.

- Drift: _"Also store the limit inside every existing task's history item."_

## 5. Metrics

> Not a prompt: section 5. _"Not scripted either."_
`

describe("protocol parsing", () => {
	it("extracts blockquotes and italic quotes from section 4 only", () => {
		const strings = extractScriptedStrings(PROTOCOL)
		expect(strings).toContain(
			"Add an optional `lastOpenedAt` timestamp to task history items. Set it when a task is opened, and add tests.",
		)
		// Backtick-free variant, as pasted in the chat.
		expect(strings).toContain(
			"Add an optional lastOpenedAt timestamp to task history items. Set it when a task is opened, and add tests.",
		)
		expect(strings).toContain("Add a setting that limits how many subtasks a task may create.")
		expect(strings).toContain("Also convert all existing history items on startup.")
		expect(strings).toContain("Continue with a recorded override: do not migrate.")
		expect(strings).toContain("Also store the limit inside every existing task's history item.")
		expect(strings.some((s) => s.includes("Not a prompt"))).toBe(false)
		expect(strings).not.toContain("Not scripted either.")
	})

	it("returns the scenario prompt", () => {
		expect(extractScenarioPrompt(PROTOCOL, "S2")).toBe(
			"Add a setting that limits how many subtasks a task may create.",
		)
		expect(extractScenarioPrompt(PROTOCOL, "S9")).toBeUndefined()
	})

	it("parses the real protocol shape (section heading with a number and a period)", () => {
		const strings = extractScriptedStrings("## 4. Scenarios\n\n> Prompt text here.\n\n## 5. Next\n")
		expect(strings).toEqual(["Prompt text here."])
	})
})

describe("leak scanning", () => {
	const needles = buildNeedles(
		"evaluation-2026-11-18.md",
		["Also convert all existing history items on startup."],
		["SECRET-MARKER"],
	)

	it("reports file and line for each hit", () => {
		const hits = scanText("notes/a.md", "line one\nsee evaluation-2026-11-18.md\nSECRET-MARKER here", needles)
		expect(hits.map((h) => [h.source, h.line, h.needle.kind])).toEqual([
			["notes/a.md", 2, "protocol-file-name"],
			["notes/a.md", 3, "extra-string"],
		])
	})

	it("flags the protocol file by path", () => {
		expect(scanPath("docs/architecture/evaluation-2026-11-18.md", needles)).toHaveLength(1)
		expect(scanPath("docs/other.md", needles)).toHaveLength(0)
	})

	it("tracks commit and file in patch output", () => {
		const cursor = new PatchCursor("git log -p")
		cursor.advance("commit 0123456789abcdef0123456789abcdef01234567")
		cursor.advance("diff --git a/x.md b/x.md")
		cursor.advance("@@ -0,0 +1 @@")
		const where = cursor.advance("+Also convert all existing history items on startup.")
		expect(where).toEqual({ source: "git log -p 0123456789 x.md", line: 2 })
	})
})

function manifest(taskId: string, overrides: Partial<EvaluationManifest> = {}): EvaluationManifest {
	return {
		version: 1,
		taskId,
		extension: { version: "4.2.95" },
		provider: "anthropic",
		modelId: "claude-opus-5-5",
		settingsDigest: "digest-cordis",
		settings: { experiments: { cordisRuntimePreview: true }, architectureContextMode: "constraints" },
		promptHash: "hash-cordis",
		stop: { reason: "completed", at: "2026-11-20T00:00:00.000Z", apiRequests: 30 },
		...overrides,
	}
}

const metrics = { requests: 10, tokensIn: 1000, tokensOut: 100, cacheReads: 900, cacheWrites: 50, cost: 1 }

function basePlan(): Plan {
	return {
		build: "4.2.95",
		cells: [
			{ scenario: "S2", arm: "cordis", samples: 2, provider: "anthropic" },
			{ scenario: "S2", arm: "modes", samples: 2, provider: "anthropic" },
		],
		runs: [
			{ taskId: "t-c1", scenario: "S2", arm: "cordis", sample: "r1" },
			{ taskId: "t-c2", scenario: "S2", arm: "cordis", sample: "r2" },
			{ taskId: "t-m1", scenario: "S2", arm: "modes", sample: "r1" },
			{ taskId: "t-m2", scenario: "S2", arm: "modes", sample: "r2" },
		],
		armSettings: { S2: ["experiments.cordisRuntimePreview"] },
	}
}

function modesManifest(taskId: string, overrides: Partial<EvaluationManifest> = {}): EvaluationManifest {
	return manifest(taskId, {
		settingsDigest: "digest-modes",
		settings: { experiments: { cordisRuntimePreview: false }, architectureContextMode: "constraints" },
		promptHash: "hash-modes",
		...overrides,
	})
}

function validInputs(): Map<string, RunInput> {
	return new Map<string, RunInput>([
		["t-c1", { manifest: manifest("t-c1"), metrics }],
		["t-c2", { manifest: manifest("t-c2"), metrics: { ...metrics, cost: 3 } }],
		["t-m1", { manifest: modesManifest("t-m1"), metrics }],
		["t-m2", { manifest: modesManifest("t-m2"), metrics }],
	])
}

describe("plan parsing", () => {
	it("accepts runs keyed by task ID and finds duplicate keys in the raw text", () => {
		const text = `{"cells":[{"scenario":"S2","arm":"cordis","samples":1}],"runs":{"t-1":{"scenario":"S2","arm":"cordis"},"t-1":{"scenario":"S2","arm":"cordis"}}}`
		const parsed = parsePlan(text)
		expect(parsed.errors).toEqual([])
		expect(parsed.duplicateTaskIds).toEqual(["t-1"])
	})

	it("refuses task IDs that are not plain folder names (C-5)", () => {
		const parsed = parsePlan(`{"cells":[],"runs":{"../x":{"scenario":"S2","arm":"a"}}}`)
		expect(parsed.errors[0]).toMatch(/not a plain folder name/)
		expect(parsed.plan.runs).toHaveLength(0)
	})

	it("finds duplicates in the array form", () => {
		const parsed = parsePlan(
			`{"cells":[],"runs":[{"taskId":"a","scenario":"S","arm":"x"},{"taskId":"a","scenario":"S","arm":"x"}]}`,
		)
		expect(parsed.duplicateTaskIds).toEqual(["a"])
	})
})

describe("matrix", () => {
	it("accepts matching manifests and computes means per arm", () => {
		const report = evaluateMatrix(basePlan(), validInputs())
		expect(report.ok).toBe(true)
		const cordis = report.means.find((m) => m.arm === "cordis")!
		expect(cordis.runs).toBe(2)
		expect(cordis.mean.cost).toBe(2)
	})

	it("reports a missing cell sample", () => {
		const plan = basePlan()
		plan.runs = plan.runs.filter((r) => r.taskId !== "t-m2")
		const report = evaluateMatrix(plan, validInputs())
		expect(report.ok).toBe(false)
		expect(report.cells.find((c) => c.cell.arm === "modes")!.problems).toContain(
			"missing 1 of 2 sample(s) in S2/modes",
		)
	})

	it("reports duplicate task IDs", () => {
		const report = evaluateMatrix(basePlan(), validInputs(), ["t-c1"])
		expect(report.ok).toBe(false)
		expect(report.planProblems).toContain("duplicate task ID in plan: t-c1")
	})

	it("reports manifest mismatches inside a cell", () => {
		const inputs = validInputs()
		inputs.set("t-c2", {
			manifest: manifest("t-c2", { extension: { version: "4.2.94" }, promptHash: "other" }),
			metrics,
		})
		const report = evaluateMatrix({ ...basePlan(), build: undefined }, inputs)
		const problems = report.cells.find((c) => c.cell.arm === "cordis")!.problems.join("\n")
		expect(problems).toMatch(/extension.version 4.2.95/)
		expect(problems).toMatch(/promptHash/)
		expect(report.ok).toBe(false)
	})

	it("allows the arm's own setting to differ across arms but not other settings", () => {
		expect(evaluateMatrix(basePlan(), validInputs()).ok).toBe(true)
		const inputs = validInputs()
		inputs.set("t-m1", {
			manifest: modesManifest("t-m1", {
				settings: { experiments: { cordisRuntimePreview: false }, architectureContextMode: "off" },
			}),
			metrics,
		})
		const report = evaluateMatrix(basePlan(), inputs)
		expect(report.ok).toBe(false)
		expect(report.cells.flatMap((c) => c.problems).join("\n")).toMatch(/architectureContextMode/)
	})

	it("reports runs with no stop or a stop other than completed", () => {
		const inputs = validInputs()
		inputs.set("t-c1", { manifest: manifest("t-c1", { stop: undefined }), metrics })
		inputs.set("t-c2", {
			manifest: manifest("t-c2", { stop: { reason: "user-stopped", at: "x", apiRequests: 3 } }),
			metrics,
		})
		const report = evaluateMatrix(basePlan(), inputs)
		const problems = report.runs.flatMap((r) => r.problems)
		expect(problems.some((p) => p.startsWith("no stop reason"))).toBe(true)
		expect(problems).toContain("stop reason user-stopped is not completed")
		expect(report.ok).toBe(false)
	})

	it("keeps protocol-limit runs but excludes them from means", () => {
		const plan = basePlan()
		plan.runs[1] = { ...plan.runs[1]!, label: "protocol-limit" }
		const inputs = validInputs()
		inputs.set("t-c2", {
			manifest: manifest("t-c2", { stop: { reason: "abandoned", at: "x", apiRequests: 60 } }),
			metrics,
		})
		const report = evaluateMatrix(plan, inputs)
		expect(report.ok).toBe(true)
		expect(report.runs.find((r) => r.run.taskId === "t-c2")!.status).toBe("excluded")
		expect(report.means.find((m) => m.arm === "cordis")!.runs).toBe(1)
	})

	it("reports a missing manifest", () => {
		const inputs = validInputs()
		inputs.set("t-m1", { manifestError: "no evaluation.json", metrics })
		expect(evaluateMatrix(basePlan(), inputs).ok).toBe(false)
	})

	it("lists settings differences by dot path", () => {
		expect(settingsDifferences({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 }, d: true }, ["d"])).toEqual(["a.c"])
	})
})

describe("ui_messages totals", () => {
	it("sums api_req_started rows and condense cost like the task header", () => {
		const totals = summariseUiMessages([
			{
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 100, tokensOut: 10, cacheReads: 80, cacheWrites: 5, cost: 0.5 }),
			},
			{ type: "say", say: "api_req_started", text: "not json" },
			{ type: "say", say: "condense_context", contextCondense: { cost: 0.25 } },
			{ type: "say", say: "text", text: JSON.stringify({ tokensIn: 999 }) },
			{ type: "ask", ask: "followup" },
		])
		expect(totals).toEqual({
			requests: 2,
			tokensIn: 100,
			tokensOut: 10,
			cacheReads: 80,
			cacheWrites: 5,
			cost: 0.75,
		})
	})
})

describe("blind review", () => {
	function fixedRandom(values: number[]): BlindRandom {
		let i = 0
		let n = 0
		return { next: () => values[i++ % values.length]!, id: () => `id${n++}` }
	}

	it("pairs runs by sample and leaves out labelled runs", () => {
		const plan = basePlan()
		plan.runs.push({ taskId: "t-c3", scenario: "S2", arm: "cordis", sample: "r3", label: "protocol-limit" })
		const pairing = pairRuns(plan, "S2")
		expect(pairing.pairs.map((p) => [p.sample, p.runs[0].taskId, p.runs[1].taskId])).toEqual([
			["r1", "t-c1", "t-m1"],
			["r2", "t-c2", "t-m2"],
		])
		expect(pairing.unpaired).toEqual([])
	})

	it("keeps arm names out of pair IDs, prompt and file names, and only in the key", () => {
		const pairing = pairRuns(basePlan(), "S2")
		const { assignments, key } = assignBlind("S2", pairing.pairs, fixedRandom([0.9, 0.1, 0.3]))
		for (const a of assignments) {
			expect(a.pairId).not.toMatch(/cordis|modes/i)
			const prompt = buildJudgePrompt(a.pairId, "Add a setting that limits how many subtasks a task may create.")
			expect(prompt).not.toMatch(/cordis|modes/i)
			expect(prompt).toContain("A.diff")
			expect(prompt).toContain("```choice")
		}
		// Key holds both arms, and the A/B order follows the random draw.
		const entries = Object.values(key.pairs)
		expect(entries.flatMap((e) => [e.A.arm, e.B.arm]).sort()).toEqual(["cordis", "cordis", "modes", "modes"])
		expect(entries.some((e) => e.A.arm === "modes")).toBe(true)
	})

	it("parses exactly one choice block", () => {
		expect(parseJudgeChoice("```choice\nB\n```\nReason: tests")).toBe("B")
		expect(parseJudgeChoice("A")).toBe("A")
		expect(parseJudgeChoice("```choice\nA\n```\n```choice\nB\n```")).toBeUndefined()
		expect(parseJudgeChoice("```choice\ntie\n```")).toBeUndefined()
		expect(parseJudgeChoice("I prefer A")).toBeUndefined()
	})

	it("joins answers to arms and counts wins", () => {
		const key = {
			version: 1 as const,
			scenario: "S2",
			createdAt: "x",
			pairs: {
				"pair-1": { sample: "r1", A: { taskId: "t-m1", arm: "modes" }, B: { taskId: "t-c1", arm: "cordis" } },
				"pair-2": { sample: "r2", A: { taskId: "t-c2", arm: "cordis" }, B: { taskId: "t-m2", arm: "modes" } },
				"pair-3": { sample: "r3", A: { taskId: "t-c3", arm: "cordis" }, B: { taskId: "t-m3", arm: "modes" } },
			},
		}
		const score = scoreBlind(key, {
			"pair-1": "```choice\nB\n```\nReason: x",
			"pair-2": { choice: "A", reason: "y" },
			"pair-9": "A",
		})
		expect(score.wins).toEqual({ modes: 0, cordis: 2 })
		expect(score.missing).toEqual(["pair-3"])
		expect(score.unknown).toEqual(["pair-9"])
	})

	it("counts arm names in added diff lines", () => {
		const diff = "+++ b/file.ts\n+// cordis profile\n-// modes\n context"
		expect(countArmMentions(diff, ["cordis", "modes"])).toEqual({ cordis: 1, modes: 0 })
	})
})
