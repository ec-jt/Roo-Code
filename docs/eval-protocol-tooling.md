# Evaluation protocol tooling

`scripts/eval-protocol.ts` is a developer-only script. It applies the method fixes from Harness² to the Roo evaluation protocol in [`docs/architecture/evaluation-2026-11-18.md`](architecture/evaluation-2026-11-18.md), and grades the long-horizon scenario L1 in [`docs/architecture/evaluation-2026-11-22-long-horizon.md`](architecture/evaluation-2026-11-22-long-horizon.md) (section 6 below). It is not shipped in the VSIX.

Records: [ADR-2026-11-20-feature-gating-evaluation-and-lessons](architecture/decisions/accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md) (evaluation tooling, developers only) and [R-6](architecture/risks.md) (evaluation results can be invalid or biased).

The script does not use `packages/evals`. That package runs coding exercises with Docker, Postgres and Redis. This protocol uses Roo task folders and workspace snapshots made by hand.

## Run it

```bash
pnpm eval:protocol --help
pnpm eval:protocol <command> [options]
```

This is the same as `npx tsx scripts/eval-protocol.ts`. The script uses only Node built-ins, `git`, and `safeWriteJson` from `src/utils/`.

| Exit code | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| 0         | Check passed                                                                                   |
| 1         | Check failed (leak found, invalid matrix, missing answers, a hidden test or `npm test` failed) |
| 2         | Usage or input error (missing option, unreadable JSON file)                                    |

## Input data

Turn on the experiment **Evaluation recording** (`evaluationRecording`) before the runs. Each new task then writes `<globalStorage>/tasks/<taskId>/evaluation.json`. The shape is defined in `src/core/task/evaluation-recording.ts`:

- `version: 1`, `taskId`, `parentTaskId?`, `createdAt`;
- `extension.version`, `provider`, `modelId`, `mode`, `profile`;
- `settingsDigest`, `settings` (whitelisted, non-secret settings only), `promptHash`;
- `stop: { reason, at, apiRequests }`, where `reason` is `completed`, `user-stopped`, `error`, `mistake-limit` or `abandoned`.

On macOS, `<globalStorage>` is usually `~/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline`, or the custom storage path set in Roo.

## 1. `leak-check`: before each run

```bash
pnpm eval:protocol leak-check --workspace ../roo-eval-S2-cordis-r1 \
  --protocol docs/architecture/evaluation-2026-11-18.md [--extra extra-strings.txt]
```

The command fails (exit 1) if the workspace contains the protocol file name or a scripted string. It searches:

- every file under the workspace, tracked, untracked and ignored, except `node_modules` and `.git`, files over `--max-file-bytes` (default 5 MiB), and binary files (files with a NUL byte);
- file paths (for example a leftover copy of the protocol);
- `git diff HEAD`, if the workspace is a git work tree;
- `git log -p --all`. Use `--max-commits <n>` to limit it.

The scripted strings are:

- every blockquote in section 4 of the protocol (the task prompts);
- every italic quoted string in section 4 (`_"..."_`, the scripted replies);
- each of these again without Markdown backticks, because prompts are pasted as plain text;
- each non-empty line of `--extra`, except lines that start with `#`.

Each hit prints as `file:line: kind "string"`. A git hit names the commit and the file inside the patch, and the line counts from that file's `diff --git` header. A hit without a line number is a path hit. `--max-print` limits the printed hits (default 200). The total is always printed.

This applies the idea of Harness² `assert_no_leak_paths` (`core/context.py`). The code is not copied.

### `--forbid <dir>`: hidden material

`--forbid` can be given more than once. Each folder must be outside the workspace. The check also fails on:

- **forbidden lines:** any distinctive line of any text file under the folder, found anywhere in a workspace file or in the git history. A line is distinctive when, after trimming, it has at least 32 characters, contains a letter, is not an `import` statement, and is not in a short list of lines common to every Node project. The match is a substring match, so indentation does not matter.
- **forbidden file names:** a workspace file whose base name equals the name of a file under the folder (for example `P3.test.mjs` or `drift.md`). Generic names such as `package.json`, `README.md`, `server.mjs` and `lib.mjs` are ignored.

Hits print as `forbidden-line` or `forbidden-file-name`. For L1, pass the hidden tests and the phase prompts, and the drift message with `--extra`:

```bash
pnpm eval:protocol leak-check --workspace ../l1-hybrid-r1 \
  --protocol docs/architecture/evaluation-2026-11-22-long-horizon.md \
  --forbid research/eval-long/l1/hidden-tests --forbid research/eval-long/l1/phases \
  --extra research/eval-long/l1/drift.md
```

The L1 protocol has no section 4 prompts, so it adds 0 scripted strings. The file name `evaluation-2026-11-22-long-horizon.md` is still checked.

**Run it before P1 only.** From P1 on, the workspace contains the prompts' content by design (the model reads the prompt and writes code to it), so later runs would report hits on the phase prompts. A run before each later phase still makes sense with `--forbid research/eval-long/l1/hidden-tests` alone: a hit there means hidden test code reached the workspace.

**What it cannot see:**

- text that was reworded, translated, re-wrapped onto other lines, or encoded (base64, compressed, in images);
- files over the size limit, binary files, and anything inside `node_modules` or `.git` other than the git history;
- git objects that no ref can reach (stash entries, the reflog, dangling objects), and other worktrees of the same repository;
- anything outside the workspace that the model can still open: the main checkout, home folders, MCP servers, the browser;
- section 4 strings written in a format other than blockquotes or `_"..."_`. Use `--extra` for those.

Running it on the main checkout always fails, because the protocol file is there. On 2026-11-20 it found 72 hits (58 for the protocol file name, 14 for scripted strings) in about 24 seconds.

## 2. `matrix`: after the runs

```bash
pnpm eval:protocol matrix --plan plan.json \
  --tasks-dir "$HOME/Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks"
```

The command reads only the task folders listed in `plan.runs`. It never lists the tasks folder and never writes to it ([C-5](architecture/constraints.md)). It refuses a task ID that is not a plain folder name. From each folder it reads:

- `evaluation.json`: the manifest and the stop reason;
- `ui_messages.json`: request count, tokens, cache and cost;
- `api_conversation_history.json`: only the number of entries is printed, no content ([Q-SEC-2](architecture/quality.md)).

It reports:

- **Missing samples:** a cell has fewer valid or excluded runs than its `samples`.
- **Duplicate task IDs:** in the plan. A duplicate key in a JSON object is found in the raw text.
- **Duplicate cells:** two cells with the same key. The key is `scenario/arm`, or `scenario/group/arm` when the cell has a `group`.
- **Manifest mismatch inside a cell:** `extension.version`, `settingsDigest`, `provider`, `modelId` or `promptHash` differ between runs of the same cell.
- **Mismatch across arms:** `extension.version`, `provider` or `modelId` differ between arms of the same scenario and group. Settings may differ only in the keys listed in `armSettings` for that scenario. The prompt hash may differ between arms (for example the `/plan ` prefix). Runs in different groups are never compared.
- **Plan mismatch:** the build is not `plan.build`, or the provider or model is not the one in the cell.
- **Stop:** no manifest, no `stop`, or a `stop.reason` other than `completed`. A run labelled `protocol-limit` in the plan is allowed any stop reason. It counts as present, but it is excluded from means and blind review.

It prints a table per run (requests, tokens in and out, cache reads and writes, cost, number of history entries), a table per cell, the problems, and the mean per arm over valid runs. When the plan uses groups, each table has a `group` column and the means are per scenario, group and arm. Exit 1 if any cell or run is invalid.

This applies the idea of Harness² `Ledger.assert_identity` (`core/ledger.py`) and run fingerprints (`core/runmark.py`).

**How totals are summed.** The totals are summed the same way as the task header (`consolidateTokenUsage` in `packages/core`):

- each `say: "api_req_started"` row adds its `tokensIn`, `tokensOut`, `cacheReads`, `cacheWrites` and `cost`;
- each `condense_context` and `sliding_window_truncation` row adds its own cost;
- requests is the number of `api_req_started` rows.

Rows that fail to parse still count as requests, but add no tokens. `tokensIn` already includes cache tokens. Cost is the cost Roo recorded, not the provider's bill.

### Example `plan.json`

```json
{
	"build": "4.2.95",
	"armSettings": {
		"S2": ["experiments.cordisRuntimePreview"]
	},
	"cells": [
		{ "scenario": "S2", "arm": "cordis", "samples": 2, "provider": "anthropic", "modelId": "claude-opus-5-5" },
		{ "scenario": "S2", "arm": "modes", "samples": 2, "provider": "anthropic", "modelId": "claude-opus-5-5" }
	],
	"runs": {
		"01a1fb00-0000-7000-8000-000000000001": { "scenario": "S2", "arm": "cordis", "sample": "r1" },
		"01a1fb00-0000-7000-8000-000000000002": { "scenario": "S2", "arm": "modes", "sample": "r1" },
		"01a1fb00-0000-7000-8000-000000000003": { "scenario": "S2", "arm": "cordis", "sample": "r2" },
		"01a1fb00-0000-7000-8000-000000000004": { "scenario": "S2", "arm": "modes", "sample": "r2" },
		"01a1fb00-0000-7000-8000-000000000005": {
			"scenario": "S2",
			"arm": "modes",
			"sample": "r3",
			"label": "protocol-limit"
		}
	}
}
```

- `runs` can also be an array of `{ "taskId": ..., "scenario": ..., "arm": ... }`.
- `sample` pairs runs for blind review.
- `label` is `protocol-limit` (stopped by the protocol's 60-request limit, excluded from outcome scoring) or `invalid` (always fails the cell).
- `armSettings` lists flattened `settings` keys from `evaluation.json` that may differ between the arms of a scenario. For S1 this is `architectureContextMode`. For S3 it is `pruneToolResultsOnOverflow` and `offloadImagesOnOverflow`.
- The `settingsDigest` covers all whitelisted settings, so it differs between arms by design. It is compared only inside a cell.
- `group` (optional, on cells and runs) separates repeats of the same scenario and arms, for example one group per model. See below.

### Groups: more than one model in one plan

Set the same `group` on a cell and on each of its runs. A run matches the cell with the same scenario, group and arm. Without `group`, a plan with the same scenario and arm on two models fails with `duplicate cell`, and the cross-arm check compares runs on different models.

With groups:

- the cell key is `scenario/group/arm` (for example `S2/opus/cordis`); plans without groups keep `scenario/arm`;
- arms are compared only within the same scenario and group, so a model difference between groups is not a problem, but a model difference between arms inside one group is;
- means are reported per scenario, group and arm;
- `blind-export` pairs runs only within one group (`--group`).

```json
{
	"build": "4.2.97",
	"armSettings": { "S2": ["experiments.cordisRuntimePreview"] },
	"cells": [
		{
			"scenario": "S2",
			"group": "opus",
			"arm": "modes",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		},
		{
			"scenario": "S2",
			"group": "opus",
			"arm": "cordis",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		},
		{
			"scenario": "S2",
			"group": "deepseek",
			"arm": "modes",
			"samples": 2,
			"provider": "deepseek",
			"modelId": "deepseek-flash"
		},
		{
			"scenario": "S2",
			"group": "deepseek",
			"arm": "cordis",
			"samples": 2,
			"provider": "deepseek",
			"modelId": "deepseek-flash"
		}
	],
	"runs": {
		"01a1fb00-0000-7000-8000-000000000001": { "scenario": "S2", "group": "opus", "arm": "modes", "sample": "r1" },
		"01a1fb00-0000-7000-8000-000000000002": { "scenario": "S2", "group": "opus", "arm": "cordis", "sample": "r1" },
		"01a1fb00-0000-7000-8000-000000000003": { "scenario": "S2", "group": "opus", "arm": "modes", "sample": "r2" },
		"01a1fb00-0000-7000-8000-000000000004": { "scenario": "S2", "group": "opus", "arm": "cordis", "sample": "r2" },
		"01a1fb00-0000-7000-8000-000000000005": {
			"scenario": "S2",
			"group": "deepseek",
			"arm": "modes",
			"sample": "r1"
		},
		"01a1fb00-0000-7000-8000-000000000006": {
			"scenario": "S2",
			"group": "deepseek",
			"arm": "cordis",
			"sample": "r1"
		},
		"01a1fb00-0000-7000-8000-000000000007": {
			"scenario": "S2",
			"group": "deepseek",
			"arm": "modes",
			"sample": "r2"
		},
		"01a1fb00-0000-7000-8000-000000000008": {
			"scenario": "S2",
			"group": "deepseek",
			"arm": "cordis",
			"sample": "r2"
		}
	}
}
```

### Phases and grades

A multi-phase scenario (L1) sets `phases` on the plan and `grades` on each run:

- `phases`: the phase names, for example `["P1", "P2", "P3", "P4"]`. With `phases` set, a run without `grades` is invalid, and a phase that has no entry in the run's grades file is printed as a note (`not graded: P3`).
- `grades` (on a run): the path of the run's `grades.json` written by `grade`, relative to the plan file. A missing or unreadable file makes the run invalid.

`matrix` then prints two more tables before the cost means:

- **Hidden tests per run:** passed/total per phase, the final result (the last graded phase, which runs every earlier suite), the number of distinct regressed tests, the score, and whether the project's own `npm test` passed in the last graded phase.
- **Hidden tests per arm and group:** over valid graded runs, the mean of passed and total in the last phase, the mean regressions, the mean score, and how many runs had passing own tests.

The score is the protocol's rank metric (section 6, rule 1): hidden tests passed in the last phase, minus regressions. A test that regressed and was fixed later still counts as one regression. The cost table is unchanged, so quality and cost appear side by side.

## 3. `blind-export`: prepare blind review

```bash
pnpm eval:protocol blind-export --plan plan.json --scenario S2 [--group opus] --workspaces workspaces.json --out ../eval-blind-S2-opus
```

Options for multi-phase scenarios:

- `--prompt-file <file>`: take the task prompt from a file instead of section 4 of `--protocol`. For L1 this is `phases/P1.md`.
- `--followups <file>` (repeatable): messages the user sent after the task prompt, in the order sent. The judge prompt lists them under **Messages the user sent during the task**, one `### Message n` per file, as quotes. File names are not shown. For L1, pass `P2.md`, `P3.md`, `P4.md` and then `drift.md` (the drift message was sent during P4).
- `--arms <a,b>`: pair only these two arms. L1 has four arms, so export one arm pair at a time.

When the plan uses groups, export one group at a time with `--group`. If the scenario's runs are in more than one group and `--group` is not given, the command pairs nothing and reports the groups. The key records the group.

`workspaces.json` maps each task ID to its workspace and base commit. Relative paths resolve from the map file's folder.

```json
{
	"base": "9deda9b58",
	"runs": {
		"01a1fb00-0000-7000-8000-000000000001": "../roo-eval-S2-cordis-r1",
		"01a1fb00-0000-7000-8000-000000000002": { "path": "../roo-eval-S2-modes-r1", "base": "9deda9b58" }
	}
}
```

How the export works:

1. Runs pair by `sample`, within one group. If a run has no `sample`, runs pair by their order in the plan. Runs with a `label` are left out. The scenario (in that group) needs exactly two arms.
2. Each pair gets a random ID (`pair-<8 hex>`). A random draw decides which run is `A` and which is `B`, and the pair order is shuffled.
3. For each run, the command writes the diff against the base commit: `git diff <base>` for tracked changes, plus a new-file diff for each untracked, non-ignored file. The workspace is only read.
4. The output is laid out as follows:

    ```text
    <out>/key.json                 # task ID and arm for A and B per pair: keep away from the judge
    <out>/answers.template.json    # one empty answer per pair ID
    <out>/judge/<pair-id>/A.diff
    <out>/judge/<pair-id>/B.diff
    <out>/judge/<pair-id>/judge-prompt.md
    ```

The judge prompt contains the scenario's task prompt from section 4 of the protocol (`--protocol`, default as above), the file names `A.diff` and `B.diff`, and the answer format. It contains no arm names. The judge must give exactly one choice in a fenced `choice` block and then a written reason.

The command does not call any model API and does not read API keys. To judge, open only `<out>/judge/<pair-id>/` as the workspace of a separate Roo task, with a model that took no part in the runs, and paste `judge-prompt.md`. Copy each reply into `answers.json` under its pair ID.

If an added diff line contains an arm name as a whole word (for example a comment that mentions "cordis"), the command prints a warning for that pair and side, but does not print the arm. Review that diff before you judge. The diff content is never changed. The match is case-insensitive, and a word boundary is any character that is not a letter or a digit: `customModes` does not match the arm `modes`, but `"modes"`, `modes.` and `cordis-preview` (for `cordis`) do.

This applies the idea of Harness² `core/selection.py` (anonymous candidates, separate judge, written reason).

## 4. `blind-score`: join answers to arms

```bash
pnpm eval:protocol blind-score --out ../eval-blind-S2 --answers answers.json
```

`answers.json` is keyed by pair ID. Each value can be:

- `"A"` or `"B"`;
- the judge's full reply, which must contain exactly one choice block;
- `{ "choice": "<one of the above>", "reason": "..." }`.

The command prints the winner per pair and the wins per arm. Exit 1 if an answer is missing or invalid. An answer for an unknown pair ID is reported and ignored. There is no tie option.

## 5. `grade`: hidden tests per phase

```bash
pnpm eval:protocol grade --workspace <dir> --phase <P1..P4> --tests research/eval-long/l1/hidden-tests \
  [--amount-mode decimal|cents] --out <grades.json> \
  [--start-timeout 30] [--test-timeout 120] [--own-test-timeout 300]
```

The command runs the hidden tests of one phase against a workspace and records the result. It runs the workspace's own npm scripts, so use it only on workspaces you would run anyway.

1. It refuses a `--tests` folder or `--out` file inside the workspace.
2. It copies `P1.test.mjs` up to `<phase>.test.mjs` from `--tests` into a new temporary folder outside the workspace. It also copies `fixtures/seed-expenses.json` there as the server's data file.
3. If the workspace has no `node_modules`, it runs `npm install` in the workspace.
4. It runs `npm start` in the workspace, in its own process group, with `PORT` set to a free port and `DATA_FILE` set to the copied seed file. It waits until the port accepts a connection, up to `--start-timeout` seconds (default 30).
5. It runs `node --test --test-reporter=tap` on each copied file, from the temporary folder, with `BASE_URL=http://127.0.0.1:<port>` and `AMOUNT_MODE` set.
6. It stops the server: `SIGTERM` to the process group, then `SIGKILL`.
7. It runs the workspace's `npm test`, with a timeout (default 300 seconds), and records whether it passed.
8. It adds the phase to `--out` (or replaces an earlier entry for the same phase), writes it with `safeWriteJson`, and deletes the temporary folder.

`--amount-mode` defaults to `decimal` for P1 to P3 and `cents` for P4. Exit 0 when the server started, every hidden test passed, and `npm test` passed. Otherwise exit 1.

The workspace is not modified, apart from `npm install` (when `node_modules` is missing) and whatever the project's own `npm start` and `npm test` do. When the workspace is the top of its own git work tree, `grade` compares `git status` before and after and records any new paths in `workspaceChanges`, with a note. A first `npm install` usually adds `package-lock.json`.

### `grades.json`

```json
{
	"version": 1,
	"entries": [
		{
			"phase": "P3",
			"amountMode": "decimal",
			"gradedAt": "2026-11-22T21:03:10.000Z",
			"testsPassed": 39,
			"testsFailed": 0,
			"perFile": { "P1.test.mjs": { "passed": 16, "failed": 0 } },
			"ownTestsPass": true,
			"regressions": [],
			"results": { "P1.test.mjs > POST /expenses creates an expense and returns 201 with all fields": "pass" },
			"serverStarted": true,
			"workspaceChanges": ["?? package-lock.json"],
			"notes": []
		}
	]
}
```

- Entries are sorted by phase.
- A test ID is `<file> > <test name>`.
- `regressions` lists the test IDs that passed in any earlier phase of the same `grades.json` and do not pass now. A test that did not run now (for example because the server did not start) counts as not passing.
- Re-grading a phase replaces its entry. Regressions are computed against earlier phases only.
- Use one `grades.json` per run. Keep it outside the workspace.

**P1 to P3 after P4.** The P4 grade runs the P1 to P3 files again in `cents` mode. Their test IDs are the same as in decimal mode, so a P1 test that passed in P1 and fails in P4 counts as a regression.

## 6. L1: long-horizon scenario

The protocol is [`docs/architecture/evaluation-2026-11-22-long-horizon.md`](architecture/evaluation-2026-11-22-long-horizon.md). The materials are in `research/eval-long/l1/`. They are git-ignored and must never be committed or copied into a run workspace.

| Path                                        | Content                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `README.md`                                 | The product summary. It becomes the workspace `README.md`.                                               |
| `phases/P1.md` to `phases/P4.md`            | The exact phase prompts. Paste each one as it is.                                                        |
| `drift.md`                                  | The P4 drift message, verbatim from the protocol.                                                        |
| `hidden-tests/P1.test.mjs` to `P4.test.mjs` | Hidden tests: Node 20, `node:test` and `fetch`, no dependencies. They read `BASE_URL` and `AMOUNT_MODE`. |
| `hidden-tests/fixtures/seed-expenses.json`  | Seed data file in the P1 to P3 format (decimal `amount`). `grade` starts the server with a copy of it.   |
| `reference/`                                | Reference implementation after P4. It passes P1 to P4 in cents mode.                                     |
| `reference-p3/`                             | Snapshot after P3. It passes P1 to P3 in decimal mode.                                                   |
| `reference-p1/`                             | Snapshot after P1. It passes P1 in decimal mode.                                                         |
| `grade-runs/`                               | Recorded `grade` output for the references.                                                              |

**Amount mode.** P1 to P3 tests are parametrised with `AMOUNT_MODE=decimal|cents`. In `cents` mode they send and expect `amountCents` (integer cents) and the CSV column `amountCents`. P4 tests always use cents and ignore `AMOUNT_MODE`.

**Seed data.** P1 reads `legacy-1`, and P4 reads, updates and deletes `legacy-2` and `legacy-3`. This tests the P4 rule "stored data from earlier phases is still readable". It works only because every phase prompt fixes the storage format: a JSON array in the file named by `DATA_FILE`.

### Commands for one run of one arm

Example: arm `hybrid`, sample `r1`. `L1=research/eval-long/l1`. The workspace and the grades file are outside the repository.

1. Create the workspace:

    ```bash
    mkdir ../l1-hybrid-r1 && cp research/eval-long/l1/README.md ../l1-hybrid-r1/
    git -C ../l1-hybrid-r1 init -q && git -C ../l1-hybrid-r1 add -A && git -C ../l1-hybrid-r1 commit -qm "L1 base"
    git -C ../l1-hybrid-r1 rev-parse HEAD   # record as the base commit for blind-export
    ```

2. Leak check, before P1:

    ```bash
    pnpm eval:protocol leak-check --workspace ../l1-hybrid-r1 \
      --protocol docs/architecture/evaluation-2026-11-22-long-horizon.md \
      --forbid research/eval-long/l1/hidden-tests --forbid research/eval-long/l1/phases \
      --extra research/eval-long/l1/drift.md
    ```

3. Open `../l1-hybrid-r1` as the only folder of a new VS Code window. Apply the arm's settings (protocol section 3) and start the arm's mode.
4. **P1:** paste `phases/P1.md` (cordis arm: prefix `/plan `). Wait for `attempt_completion`. Then grade:

    ```bash
    pnpm eval:protocol grade --workspace ../l1-hybrid-r1 --phase P1 \
      --tests research/eval-long/l1/hidden-tests --out ../l1-grades/hybrid-r1.json
    ```

5. **P2:** paste `phases/P2.md` into the same task. Wait for `attempt_completion`. Grade with `--phase P2`.
6. **P3:** paste `phases/P3.md`. Wait for `attempt_completion`. Grade with `--phase P3`.
7. **P4:** paste `phases/P4.md`. Count the API requests of this phase in the task header. At about the 10th request of P4, send `drift.md` as a user message (queue it if the model is busy). Wait for `attempt_completion` of P4. Grade with `--phase P4` (amount mode `cents` by default).
8. Stop at the end of P4, or at 250 API requests in total. Record the task ID, the drift handling (reported, ignored or silent), and whether the model rewrote the stored file in place.

Grade only after `attempt_completion`. Do not grade while the model is still working: `npm start` would compete with any server the model started.

### Example `plan.json` for L1

```json
{
	"build": "4.2.102",
	"phases": ["P1", "P2", "P3", "P4"],
	"armSettings": { "L1": ["experiments.parallelSubtasks"] },
	"cells": [
		{
			"scenario": "L1",
			"group": "opus",
			"arm": "modes",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		},
		{
			"scenario": "L1",
			"group": "opus",
			"arm": "cordis",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		},
		{
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		},
		{
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid-parallel",
			"samples": 2,
			"provider": "anthropic",
			"modelId": "claude-opus-5-5"
		}
	],
	"runs": {
		"01a20500-0000-7000-8000-000000000001": {
			"scenario": "L1",
			"group": "opus",
			"arm": "modes",
			"sample": "r1",
			"grades": "../l1-grades/modes-r1.json"
		},
		"01a20500-0000-7000-8000-000000000002": {
			"scenario": "L1",
			"group": "opus",
			"arm": "cordis",
			"sample": "r1",
			"grades": "../l1-grades/cordis-r1.json"
		},
		"01a20500-0000-7000-8000-000000000003": {
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid",
			"sample": "r1",
			"grades": "../l1-grades/hybrid-r1.json"
		},
		"01a20500-0000-7000-8000-000000000004": {
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid-parallel",
			"sample": "r1",
			"grades": "../l1-grades/hybrid-parallel-r1.json"
		},
		"01a20500-0000-7000-8000-000000000005": {
			"scenario": "L1",
			"group": "opus",
			"arm": "modes",
			"sample": "r2",
			"grades": "../l1-grades/modes-r2.json"
		},
		"01a20500-0000-7000-8000-000000000006": {
			"scenario": "L1",
			"group": "opus",
			"arm": "cordis",
			"sample": "r2",
			"grades": "../l1-grades/cordis-r2.json"
		},
		"01a20500-0000-7000-8000-000000000007": {
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid",
			"sample": "r2",
			"grades": "../l1-grades/hybrid-r2.json"
		},
		"01a20500-0000-7000-8000-000000000008": {
			"scenario": "L1",
			"group": "opus",
			"arm": "hybrid-parallel",
			"sample": "r2",
			"grades": "../l1-grades/hybrid-parallel-r2.json"
		}
	}
}
```

`evaluation.json` records the task profile in its top-level `profile` field, not in `settings`, so the profile needs no `armSettings` entry, and `matrix` does not compare it. Inside `settings`, only the parallel subtasks experiment differs between arms (hybrid-parallel against the others). Check the `profile` field of one manifest per arm by hand. Then:

```bash
pnpm eval:protocol matrix --plan plan.json --tasks-dir "<globalStorage>/tasks"
pnpm eval:protocol blind-export --plan plan.json --scenario L1 --group opus --arms hybrid,modes \
  --workspaces workspaces.json --out ../eval-blind-L1-hybrid-modes \
  --prompt-file research/eval-long/l1/phases/P1.md \
  --followups research/eval-long/l1/phases/P2.md --followups research/eval-long/l1/phases/P3.md \
  --followups research/eval-long/l1/phases/P4.md --followups research/eval-long/l1/drift.md
```

The main task's `evaluation.json` is the run's manifest. One task covers all four phases, so its stop reason is the reason of the last stop.

## Tests

```bash
cd src && npx vitest run --dir .. ../scripts/__tests__/eval-protocol.spec.ts
```

The tests cover the pure functions in `scripts/eval-protocol/lib.ts`:

- extracting scripted strings and scenario prompts;
- leak matching and patch line tracking, and `--forbid` lines and file names;
- plan parsing, including `phases` and `grades`;
- matrix checks, with and without groups, and with grades;
- `ui_messages.json` totals;
- run pairing (per group, and with `--arms`), anonymisation, arm-name matching, the follow-up section of the judge prompt, parsing the choice block, and scoring;
- `grades.json` parsing, regressions, TAP parsing (Node 20 and Node 22+ layouts) and test file selection.

The CLI file itself (IO, git calls and processes) was checked by hand, not by unit tests. `grade` was run end to end against `research/eval-long/l1/reference` for P1 to P4 (output in `research/eval-long/l1/grade-runs/`).
