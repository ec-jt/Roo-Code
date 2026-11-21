# Evaluation protocol tooling

`scripts/eval-protocol.ts` is a developer-only script. It applies the method fixes from Harness² to the Roo evaluation protocol in [`docs/architecture/evaluation-2026-11-18.md`](architecture/evaluation-2026-11-18.md). It is not shipped in the VSIX.

Records: [ADR-2026-11-20-feature-gating-evaluation-and-lessons](architecture/decisions/accepted/ADR-2026-11-20-feature-gating-evaluation-and-lessons.md) (evaluation tooling, developers only) and [R-6](architecture/risks.md) (evaluation results can be invalid or biased).

The script does not use `packages/evals`. That package runs coding exercises with Docker, Postgres and Redis. This protocol uses Roo task folders and workspace snapshots made by hand.

## Run it

```bash
pnpm eval:protocol --help
pnpm eval:protocol <command> [options]
```

This is the same as `npx tsx scripts/eval-protocol.ts`. The script uses only Node built-ins, `git`, and `safeWriteJson` from `src/utils/`.

| Exit code | Meaning                                                     |
| --------- | ----------------------------------------------------------- |
| 0         | Check passed                                                |
| 1         | Check failed (leak found, invalid matrix, missing answers)  |
| 2         | Usage or input error (missing option, unreadable JSON file) |

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

## 3. `blind-export`: prepare blind review

```bash
pnpm eval:protocol blind-export --plan plan.json --scenario S2 [--group opus] --workspaces workspaces.json --out ../eval-blind-S2-opus
```

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

## Tests

```bash
cd src && npx vitest run --dir .. ../scripts/__tests__/eval-protocol.spec.ts
```

The tests cover the pure functions in `scripts/eval-protocol/lib.ts`:

- extracting scripted strings and scenario prompts;
- leak matching and patch line tracking;
- plan parsing;
- matrix checks, with and without groups;
- `ui_messages.json` totals;
- run pairing (per group), anonymisation, arm-name matching, parsing the choice block, and scoring.

The CLI file itself (IO and git calls) was checked by hand, not by unit tests.
