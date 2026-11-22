// Run from src/ (the nearest vitest config): cd src && npx vitest run --dir .. ../scripts/__tests__/eval-protocol.spec.ts
// Vitest globals (describe, it, expect) come from src/vitest.config.ts.
import {
	type BlindRandom,
	type EvaluationManifest,
	type GradeEntry,
	type Plan,
	type RunInput,
	PatchCursor,
	assignBlind,
	buildJudgePrompt,
	buildNeedles,
	collectResults,
	computeRegressions,
	countArmMentions,
	distinctiveLines,
	evaluateMatrix,
	extractScenarioPrompt,
	extractScriptedStrings,
	matchLine,
	pairRuns,
	parseGrades,
	parseJudgeChoice,
	parsePlan,
	parseTap,
	scanForbiddenName,
	scanPath,
	scanText,
	scoreBlind,
	selectPhaseTestFiles,
	settingsDifferences,
	summariseGrades,
	summariseUiMessages,
	upsertGradeEntry,
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

	it("parses group on cells and runs", () => {
		const parsed = parsePlan(
			`{"cells":[{"scenario":"S2","group":"opus","arm":"cordis"}],"runs":{"t-1":{"scenario":"S2","group":"opus","arm":"cordis"}}}`,
		)
		expect(parsed.errors).toEqual([])
		expect(parsed.plan.cells[0]!.group).toBe("opus")
		expect(parsed.plan.runs[0]!.group).toBe("opus")
		const bad = parsePlan(`{"cells":[{"scenario":"S2","group":3,"arm":"cordis"}],"runs":{}}`)
		expect(bad.errors[0]).toMatch(/group/)
	})

	it("lists settings differences by dot path", () => {
		expect(settingsDifferences({ a: { b: 1, c: 2 } }, { a: { b: 1, c: 3 }, d: true }, ["d"])).toEqual(["a.c"])
	})
})

function groupedPlan(): Plan {
	const cells: Plan["cells"] = []
	const runs: Plan["runs"] = []
	for (const group of ["opus", "deepseek"]) {
		for (const arm of ["cordis", "modes"]) {
			cells.push({ scenario: "S2", group, arm, samples: 2 })
			for (const sample of ["r1", "r2"]) {
				runs.push({ taskId: `${group}-${arm[0]}${sample[1]}`, scenario: "S2", group, arm, sample })
			}
		}
	}
	return { build: "4.2.95", cells, runs, armSettings: { S2: ["experiments.cordisRuntimePreview"] } }
}

function groupedInputs(): Map<string, RunInput> {
	const inputs = new Map<string, RunInput>()
	for (const group of ["opus", "deepseek"]) {
		const model =
			group === "opus"
				? { provider: "anthropic", modelId: "claude-opus-5-5" }
				: {
						provider: "deepseek",
						modelId: "deepseek-chat",
					}
		for (const n of ["1", "2"]) {
			const c = `${group}-c${n}`
			const m = `${group}-m${n}`
			inputs.set(c, { manifest: manifest(c, model), metrics: { ...metrics, cost: group === "opus" ? 4 : 1 } })
			inputs.set(m, { manifest: modesManifest(m, model), metrics })
		}
	}
	return inputs
}

describe("matrix with groups", () => {
	it("keys cells by scenario, group and arm without duplicate-cell errors", () => {
		const report = evaluateMatrix(groupedPlan(), groupedInputs())
		expect(report.planProblems).toEqual([])
		expect(report.cells).toHaveLength(4)
		expect(report.ok).toBe(true)
	})

	it("does not report a model mismatch between groups", () => {
		const problems = evaluateMatrix(groupedPlan(), groupedInputs())
			.cells.flatMap((c) => c.problems)
			.join("\n")
		expect(problems).not.toMatch(/modelId|provider/)
	})

	it("reports a model mismatch across arms inside one group", () => {
		const inputs = groupedInputs()
		inputs.set("deepseek-m1", {
			manifest: modesManifest("deepseek-m1", { provider: "deepseek", modelId: "deepseek-reasoner" }),
			metrics,
		})
		inputs.set("deepseek-m2", {
			manifest: modesManifest("deepseek-m2", { provider: "deepseek", modelId: "deepseek-reasoner" }),
			metrics,
		})
		const report = evaluateMatrix(groupedPlan(), inputs)
		expect(report.ok).toBe(false)
		const byCell = (group: string, arm: string) =>
			report.cells.find((c) => c.cell.group === group && c.cell.arm === arm)!.problems.join("\n")
		expect(byCell("deepseek", "modes")).toMatch(/arm mismatch in S2\/deepseek: modelId deepseek-chat/)
		expect(byCell("opus", "modes")).toBe("")
		expect(byCell("opus", "cordis")).toBe("")
	})

	it("checks cells per group and names the group in problems", () => {
		const plan = groupedPlan()
		plan.runs = plan.runs.filter((r) => r.taskId !== "opus-m2")
		const report = evaluateMatrix(plan, groupedInputs())
		expect(report.cells.find((c) => c.cell.group === "opus" && c.cell.arm === "modes")!.problems).toContain(
			"missing 1 of 2 sample(s) in S2/opus/modes",
		)
		expect(report.cells.find((c) => c.cell.group === "deepseek" && c.cell.arm === "modes")!.ok).toBe(true)
	})

	it("matches a run only to the cell of its own group", () => {
		const plan = groupedPlan()
		plan.runs.push({ taskId: "x-1", scenario: "S2", group: "gpt", arm: "cordis" })
		const report = evaluateMatrix(plan, groupedInputs())
		expect(report.runs.find((r) => r.run.taskId === "x-1")!.problems).toContain("no cell S2/gpt/cordis in plan")
	})

	it("reports means per group", () => {
		const report = evaluateMatrix(groupedPlan(), groupedInputs())
		const mean = (group: string) => report.means.find((m) => m.group === group && m.arm === "cordis")!
		expect(mean("opus").mean.cost).toBe(4)
		expect(mean("deepseek").mean.cost).toBe(1)
		expect(report.means).toHaveLength(4)
	})

	it("still reports a duplicate cell inside one group", () => {
		const plan = groupedPlan()
		plan.cells.push({ scenario: "S2", group: "opus", arm: "cordis", samples: 1 })
		expect(evaluateMatrix(plan, groupedInputs()).planProblems).toContain("duplicate cell in plan: S2/opus/cordis")
	})

	it("keeps the ungrouped key and messages unchanged", () => {
		const report = evaluateMatrix(basePlan(), validInputs())
		expect(report.means.every((m) => m.group === undefined)).toBe(true)
		const plan = basePlan()
		plan.cells.push({ scenario: "S2", arm: "cordis", samples: 1 })
		expect(evaluateMatrix(plan, validInputs()).planProblems).toContain("duplicate cell in plan: S2/cordis")
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

	it("pairs runs only within one group", () => {
		const plan = groupedPlan()
		const opus = pairRuns(plan, "S2", "opus")
		expect(opus.problems).toEqual([])
		expect(opus.pairs.map((p) => [p.sample, p.runs[0].taskId, p.runs[1].taskId])).toEqual([
			["r1", "opus-c1", "opus-m1"],
			["r2", "opus-c2", "opus-m2"],
		])
		const deepseek = pairRuns(plan, "S2", "deepseek")
		for (const pair of deepseek.pairs) expect(pair.runs.every((r) => r.group === "deepseek")).toBe(true)
		expect(deepseek.pairs).toHaveLength(2)
	})

	it("refuses to pair across groups when no group is chosen", () => {
		const pairing = pairRuns(groupedPlan(), "S2")
		expect(pairing.pairs).toEqual([])
		expect(pairing.problems[0]).toMatch(/more than one group/)
	})

	it("records the group in the blind key", () => {
		const pairing = pairRuns(groupedPlan(), "S2", "opus")
		const { key } = assignBlind("S2", pairing.pairs, fixedRandom([0.2]), new Date(0), "opus")
		expect(key.group).toBe("opus")
		const { key: ungrouped } = assignBlind("S2", pairRuns(basePlan(), "S2").pairs, fixedRandom([0.2]))
		expect("group" in ungrouped).toBe(false)
	})

	it("lists follow-up messages after the task prompt, in order, without file names", () => {
		const prompt = buildJudgePrompt("pair-1", "Phase 1: create the API.", [
			"Phase 2: add a web UI.",
			"Also convert every stored expense file in place to the new format on startup.",
			"Phase 4: store amounts as integer cents.\n\n- Accept `amountCents`.",
		])
		const task = prompt.indexOf("## Task given to both candidates")
		const heading = prompt.indexOf("## Messages the user sent during the task")
		const candidates = prompt.indexOf("## Candidates")
		expect(task).toBeGreaterThan(-1)
		expect(heading).toBeGreaterThan(task)
		expect(candidates).toBeGreaterThan(heading)
		const m1 = prompt.indexOf("### Message 1")
		const m2 = prompt.indexOf("### Message 2")
		const m3 = prompt.indexOf("### Message 3")
		expect(m1).toBeGreaterThan(heading)
		expect(m2).toBeGreaterThan(m1)
		expect(m3).toBeGreaterThan(m2)
		expect(prompt).toContain("> Also convert every stored expense file in place to the new format on startup.")
		// Blank lines inside a message stay inside the quote.
		expect(prompt).toContain("> Phase 4: store amounts as integer cents.\n>\n> - Accept `amountCents`.")
		expect(prompt).not.toMatch(/drift\.md|P[1-4]\.md/)
	})

	it("omits the follow-up section when there are none", () => {
		expect(buildJudgePrompt("pair-1", "Task.")).not.toContain("Messages the user sent")
		expect(buildJudgePrompt("pair-1", "Task.", [])).not.toContain("Messages the user sent")
	})

	it("pairs only the chosen arms when a scenario has more than two", () => {
		const plan: Plan = {
			cells: ["modes", "cordis", "hybrid"].map((arm) => ({ scenario: "L1", group: "opus", arm, samples: 1 })),
			runs: ["modes", "cordis", "hybrid"].map((arm) => ({
				taskId: `t-${arm}`,
				scenario: "L1",
				group: "opus",
				arm,
				sample: "r1",
			})),
			armSettings: {},
		}
		expect(pairRuns(plan, "L1", "opus").problems[0]).toMatch(/exactly 2 arms/)
		const chosen = pairRuns(plan, "L1", "opus", ["hybrid", "modes"])
		expect(chosen.problems).toEqual([])
		expect(chosen.pairs.map((p) => p.runs.map((r) => r.arm))).toEqual([["modes", "hybrid"]])
	})

	it("counts arm names in added diff lines", () => {
		const diff = "+++ b/file.ts\n+// cordis profile\n-// modes\n context"
		expect(countArmMentions(diff, ["cordis", "modes"])).toEqual({ cordis: 1, modes: 0 })
	})

	it("counts arm names as whole words only", () => {
		const arms = ["cordis", "modes"]
		expect(countArmMentions("+const customModes = []", arms).modes).toBe(0)
		expect(countArmMentions("+the modes arm", arms).modes).toBe(1)
		expect(countArmMentions("+use modes.", arms).modes).toBe(1)
		expect(countArmMentions('+"modes"', arms).modes).toBe(1)
		expect(countArmMentions("+Modes", arms).modes).toBe(1)
		expect(countArmMentions("+v4.2.95-cordis-preview", arms).cordis).toBe(1)
		expect(countArmMentions("+cordisRuntimePreview", arms).cordis).toBe(0)
		expect(countArmMentions("+modes2", arms).modes).toBe(0)
		// Regex characters in an arm name are matched literally.
		expect(countArmMentions("+a.b and axb", ["a.b"])["a.b"]).toBe(1)
		expect(countArmMentions("+axb", ["a.b"])["a.b"]).toBe(0)
	})
})

describe("leak scanning with --forbid", () => {
	const hiddenTest = [
		'import { test } from "node:test"',
		'import assert from "node:assert/strict"',
		"",
		'test("partial import stores valid rows and reports invalid rows with their line numbers", async () => {',
		"\tassert.equal(r.status, 200)",
		"\tassertOk(await importCsv(csv), 2, [3, 5, 6])",
		"})",
	].join("\n")

	it("keeps distinctive lines and drops short, import and common lines", () => {
		const lines = distinctiveLines(hiddenTest)
		expect(lines).toContain(
			'test("partial import stores valid rows and reports invalid rows with their line numbers", async () => {',
		)
		expect(lines).toContain("assertOk(await importCsv(csv), 2, [3, 5, 6])")
		expect(lines).not.toContain('import { test } from "node:test"')
		expect(lines).not.toContain("assert.equal(r.status, 200)")
		expect(lines).not.toContain("})")
	})

	it("finds a copied hidden-test line in a workspace file, whatever its indentation", () => {
		const needles = distinctiveLines(hiddenTest).map((text) => ({ kind: "forbidden-line" as const, text }))
		const workspaceFile = "// my tests\n    assertOk(await importCsv(csv), 2, [3, 5, 6])\n"
		const hits = scanText("test/import.test.ts", workspaceFile, needles)
		expect(hits).toHaveLength(1)
		expect(hits[0]).toMatchObject({ source: "test/import.test.ts", line: 2, needle: { kind: "forbidden-line" } })
		expect(scanText("src/server.ts", "assert.equal(r.status, 200)\n", needles)).toEqual([])
		expect(matchLine("unrelated line of code that is long enough", needles)).toEqual([])
	})

	it("flags a workspace file named like a forbidden file, but not generic names", () => {
		const names = new Set(["P3.test.mjs", "drift.md", "package.json", "seed-expenses.json"])
		expect(scanForbiddenName("test/P3.test.mjs", names)).toEqual([
			{ source: "test/P3.test.mjs", line: 0, needle: { kind: "forbidden-file-name", text: "P3.test.mjs" } },
		])
		expect(scanForbiddenName("notes/drift.md", names)).toHaveLength(1)
		expect(scanForbiddenName("package.json", names)).toEqual([])
		expect(scanForbiddenName("test/P3.test.ts", names)).toEqual([])
	})
})

function gradeEntry(
	phase: string,
	results: Record<string, "pass" | "fail">,
	extra: Partial<GradeEntry> = {},
): GradeEntry {
	const passed = Object.values(results).filter((r) => r === "pass").length
	return {
		phase,
		amountMode: "decimal",
		gradedAt: "2026-11-22T00:00:00.000Z",
		testsPassed: passed,
		testsFailed: Object.keys(results).length - passed,
		perFile: {},
		ownTestsPass: true,
		regressions: [],
		results,
		serverStarted: true,
		...extra,
	}
}

describe("grading", () => {
	it("parses grades.json, sorts entries by phase and rejects bad files", () => {
		const text = JSON.stringify({
			version: 1,
			entries: [
				gradeEntry("P2", { "P1.test.mjs > a": "pass" }),
				gradeEntry("P1", { "P1.test.mjs > a": "pass", "P1.test.mjs > b": "skip" as "pass" }),
				{ phase: "X9" },
			],
		})
		const parsed = parseGrades(text)
		expect(parsed.grades.entries.map((e) => e.phase)).toEqual(["P1", "P2"])
		expect(parsed.grades.entries[0]!.results).toEqual({ "P1.test.mjs > a": "pass" })
		expect(parsed.errors).toHaveLength(1)
		expect(parseGrades(undefined).grades.entries).toEqual([])
		expect(parseGrades("{").errors[0]).toMatch(/not valid JSON/)
		expect(parseGrades('{"version":2,"entries":[]}').errors[0]).toMatch(/version 1/)
	})

	it("computes regressions against earlier phases only", () => {
		const p1 = gradeEntry("P1", { "P1 > crud": "pass", "P1 > order": "pass", "P1 > 404": "fail" })
		const p2 = gradeEntry("P2", { "P1 > crud": "pass", "P1 > order": "pass", "P2 > form": "pass" })
		const p4 = gradeEntry("P4", { "P1 > crud": "fail" })
		// Failing now; passed in P1. A test missing from the current run counts as not passing.
		expect(
			computeRegressions([p1, p2], "P3", { "P1 > crud": "fail", "P2 > form": "pass", "P1 > 404": "fail" }),
		).toEqual(["P1 > crud", "P1 > order"])
		// A test that never passed is not a regression.
		expect(
			computeRegressions([p1], "P2", { "P1 > crud": "pass", "P1 > order": "pass", "P1 > 404": "fail" }),
		).toEqual([])
		// Re-grading an earlier phase ignores later entries.
		expect(computeRegressions([p1, p2, p4], "P2", { "P1 > crud": "pass", "P1 > order": "pass" })).toEqual([])
	})

	it("replaces the entry for a re-graded phase and keeps phase order", () => {
		let grades = parseGrades(undefined).grades
		grades = upsertGradeEntry(grades, gradeEntry("P2", {}))
		grades = upsertGradeEntry(grades, gradeEntry("P1", { a: "fail" }))
		grades = upsertGradeEntry(grades, gradeEntry("P1", { a: "pass" }))
		expect(grades.entries.map((e) => [e.phase, e.testsPassed])).toEqual([
			["P1", 1],
			["P2", 0],
		])
	})

	it("summarises grades: final suite, distinct regressions, score and missing phases", () => {
		const grades = parseGrades(
			JSON.stringify({
				version: 1,
				entries: [
					gradeEntry("P1", { a: "pass", b: "pass" }),
					gradeEntry("P2", { a: "fail", b: "pass", c: "pass" }, { regressions: ["a"] }),
					gradeEntry(
						"P3",
						{ a: "fail", b: "fail", c: "pass", d: "pass" },
						{ regressions: ["a", "b"], ownTestsPass: false },
					),
				],
			}),
		).grades
		const summary = summariseGrades(grades, ["P1", "P2", "P3", "P4"])
		expect(summary.final).toEqual({ phase: "P3", passed: 2, total: 4 })
		expect(summary.regressions).toBe(2)
		expect(summary.score).toBe(0)
		expect(summary.ownTestsPass).toBe(false)
		expect(summary.missingPhases).toEqual(["P4"])
		expect(summary.perPhase.map((p) => `${p.phase}:${p.passed}/${p.total}`)).toEqual(["P1:2/2", "P2:2/3", "P3:2/4"])
	})

	it("parses TAP from Node 22+ (top level) and Node 20 (nested under the file)", () => {
		const node22 = [
			"TAP version 13",
			"# Subtest: creates an expense",
			"ok 1 - creates an expense",
			"  ---",
			"  duration_ms: 3",
			"  ...",
			"not ok 2 - rejects \\# bad input",
			"ok 3 - later # SKIP not ready",
			"1..3",
		].join("\n")
		expect(parseTap(node22, "P1.test.mjs")).toEqual([
			{ name: "creates an expense", ok: true, skipped: false },
			{ name: "rejects # bad input", ok: false, skipped: false },
			{ name: "later", ok: true, skipped: true },
		])
		const node20 = [
			"TAP version 13",
			"# Subtest: /tmp/x/P1.test.mjs",
			"    ok 1 - creates an expense",
			"    not ok 2 - lists",
			"    1..2",
			"not ok 1 - /tmp/x/P1.test.mjs",
			"1..1",
		].join("\n")
		expect(parseTap(node20, "P1.test.mjs").map((t) => [t.name, t.ok])).toEqual([
			["creates an expense", true],
			["lists", false],
		])
	})

	it("collects results by file, skips skipped tests and de-duplicates names", () => {
		const collected = collectResults([
			{
				file: "P1.test.mjs",
				tests: [
					{ name: "a", ok: true, skipped: false },
					{ name: "a", ok: false, skipped: false },
					{ name: "s", ok: true, skipped: true },
				],
			},
			{ file: "P2.test.mjs", tests: [{ name: "form", ok: true, skipped: false }] },
		])
		expect(collected.results).toEqual({
			"P1.test.mjs > a": "pass",
			"P1.test.mjs > a #2": "fail",
			"P2.test.mjs > form": "pass",
		})
		expect(collected.perFile["P1.test.mjs"]).toEqual({ passed: 1, failed: 1 })
		expect([collected.passed, collected.failed]).toEqual([2, 1])
	})

	it("selects the hidden test files of a phase and earlier phases", () => {
		const files = [
			"P3.test.mjs",
			"fixtures",
			"P1.test.mjs",
			"P10.test.mjs",
			"P2.test.mjs",
			"P4.test.mjs",
			"notes.md",
		]
		expect(selectPhaseTestFiles(files, "P3")).toEqual(["P1.test.mjs", "P2.test.mjs", "P3.test.mjs"])
		expect(selectPhaseTestFiles(files, "P1")).toEqual(["P1.test.mjs"])
	})
})

describe("matrix with grades", () => {
	function gradedPlan(): Plan {
		const parsed = parsePlan(
			JSON.stringify({
				build: "4.2.95",
				phases: ["P4", "P1", "P2", "P3"],
				cells: [
					{ scenario: "L1", group: "opus", arm: "hybrid", samples: 2 },
					{ scenario: "L1", group: "opus", arm: "modes", samples: 1 },
				],
				runs: {
					"t-h1": { scenario: "L1", group: "opus", arm: "hybrid", sample: "r1", grades: "grades/h1.json" },
					"t-h2": { scenario: "L1", group: "opus", arm: "hybrid", sample: "r2", grades: "grades/h2.json" },
					"t-m1": { scenario: "L1", group: "opus", arm: "modes", sample: "r1" },
				},
			}),
		)
		expect(parsed.errors).toEqual([])
		return parsed.plan
	}

	function gradedInputs(): Map<string, RunInput> {
		const summary = (passed: number, regressions: number, own: boolean) =>
			summariseGrades(
				parseGrades(
					JSON.stringify({
						version: 1,
						entries: [
							gradeEntry("P1", { a: "pass" }),
							gradeEntry(
								"P4",
								Object.fromEntries(
									Array.from(
										{ length: 10 },
										(_, i) => [`t${i}`, i < passed ? "pass" : "fail"] as const,
									),
								),
								{
									regressions: Array.from({ length: regressions }, (_, i) => `r${i}`),
									ownTestsPass: own,
								},
							),
						],
					}),
				).grades,
				["P1", "P2", "P3", "P4"],
			)
		const inputs = new Map<string, RunInput>()
		inputs.set("t-h1", { manifest: manifest("t-h1"), metrics, grades: summary(8, 1, true) })
		inputs.set("t-h2", { manifest: manifest("t-h2"), metrics, grades: summary(6, 3, false) })
		inputs.set("t-m1", { manifest: manifest("t-m1"), metrics })
		return inputs
	}

	it("parses phases in phase order and the grades path on runs", () => {
		const plan = gradedPlan()
		expect(plan.phases).toEqual(["P1", "P2", "P3", "P4"])
		expect(plan.runs.find((r) => r.taskId === "t-h1")!.grades).toBe("grades/h1.json")
		expect(parsePlan('{"phases":["first"],"cells":[],"runs":{}}').errors[0]).toMatch(/phases/)
		expect(parsePlan('{"cells":[],"runs":{"t":{"scenario":"L1","arm":"a","grades":5}}}').errors[0]).toMatch(
			/grades/,
		)
	})

	it("reports hidden tests, regressions, score and own tests per arm and group", () => {
		const report = evaluateMatrix(gradedPlan(), gradedInputs())
		const hybrid = report.means.find((m) => m.arm === "hybrid")!
		expect(hybrid.group).toBe("opus")
		expect(hybrid.grades).toEqual({
			runs: 2,
			finalPassed: 7,
			finalTotal: 10,
			regressions: 2,
			score: 5,
			ownTestsPassing: 1,
		})
		// Cost metrics are still reported next to the grades.
		expect(hybrid.mean.cost).toBe(1)
	})

	it("makes a run without grades invalid when the plan has phases", () => {
		const report = evaluateMatrix(gradedPlan(), gradedInputs())
		const modesRun = report.runs.find((r) => r.run.taskId === "t-m1")!
		expect(modesRun.problems).toContain('plan has phases but the run has no "grades" path')
		expect(report.means.find((m) => m.arm === "modes")).toBeUndefined()
		expect(report.ok).toBe(false)
	})

	it("notes phases that were not graded and reports unreadable grades as a problem", () => {
		const inputs = gradedInputs()
		const report = evaluateMatrix(gradedPlan(), inputs)
		expect(report.runs.find((r) => r.run.taskId === "t-h1")!.notes).toContain("not graded: P2, P3")
		inputs.set("t-h2", { manifest: manifest("t-h2"), metrics, gradesError: "no grades file at grades/h2.json" })
		const broken = evaluateMatrix(gradedPlan(), inputs)
		expect(broken.runs.find((r) => r.run.taskId === "t-h2")!.problems).toContain("no grades file at grades/h2.json")
	})

	it("leaves plans without phases or grades unchanged", () => {
		const report = evaluateMatrix(basePlan(), validInputs())
		expect(report.ok).toBe(true)
		expect(report.means.every((m) => m.grades === undefined)).toBe(true)
	})
})
