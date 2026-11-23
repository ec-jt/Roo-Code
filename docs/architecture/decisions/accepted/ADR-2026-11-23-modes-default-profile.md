# ADR-2026-11-23-modes-default-profile: Modes is the default task profile; cordis and hybrid are opt-in

Status: accepted
Accepted-by: user
Last-verified: 2026-11-23
Paths: src/core/task/cordis-profile.ts, src/shared/experiments.ts, packages/types/src/experiment.ts, packages/types/src/global-settings.ts, webview-ui/src/components/settings/ExperimentalSettings.tsx

## Problem

[ADR-2026-11-19-keep-cordis-profile-widen-experiment](../superseded/ADR-2026-11-19-keep-cordis-profile-widen-experiment.md) made the Cordis profile the default for all providers. Its evidence was the short S2 scenario ([evaluation-2026-11-18](../../evaluation-2026-11-18.md)).

The long-horizon evaluation L1 ([evaluation-2026-11-22-long-horizon](../../evaluation-2026-11-22-long-horizon.md), section 7) ran 4 arms with 2 runs each on 4.2.102 with `claude-opus-5-5`. Data: `research/eval-long/l1-runs/`.

- **Quality:** all arms passed 53 of 53 hidden tests with 0 regressions.
- **Cost:** cordis was cheapest ($2.91 mean per run), against modes $10.97 and hybrid $12.59.
- **Drift:** cordis rewrote stored data in place in both runs. The `/plan` flow created no architecture records, so the drift rule had nothing to cite. Modes and hybrid reported the drift and did not rewrite.

Under the evaluation's decision rules, cost favours cordis and drift safety rules it out. The user decided (2026-11-23):

- make modes the default again;
- keep cordis and hybrid as opt-in;
- fix the 7 defects found in the L1 runs, then decide again.

## Decision

1. The default task profile is `modes`. A new root task uses `modes` unless the user has chosen `cordis` or `hybrid` in Settings > Experimental.
2. The choice is resolved in this order:
    - the stored task profile (`taskProfile` setting) wins when set;
    - otherwise, a stored `cordisRuntimePreview: true` means `cordis`, so that users who turned it on explicitly keep it;
    - otherwise, the default is `modes`. An absent value now means `modes`, not `cordis`.
3. Existing tasks keep their stored profile. Child tasks inherit their parent's profile, as before.
4. The release notes state the change and how to opt in.

## Alternatives considered

- **Keep cordis as the default and fix drift detection first.** Rejected by the user: the drift risk is present in the current build.
- **Make hybrid the default.** Not chosen: it was the most expensive arm in L1.
- **Decide only after fixing the defects.** Partly chosen: the default changes now, and the next decision comes after the fixes.

## Consequences

### Acceptance criteria

- With no stored settings, a new task resolves to `modes`.
- A stored `taskProfile` value wins over every other setting.
- A stored `cordisRuntimePreview: true` with no `taskProfile` resolves to `cordis`.
- The Settings > Experimental select shows `modes` as the default.
- Unit tests cover each resolution case.

### Risks

- **Rollback:** users who never touched the setting move from cordis to modes on their next new task. Their mode is no longer locked, and the modes tools apply. Older builds keep their own default, because the default is not stored ([C-5](../../constraints.md)).
- **Users who had `cordisRuntimePreview: true` stored only because an older version saved all defaults:** they stay on cordis. This cannot be told apart from an explicit choice without a migration, and migration is not done (C-5).
- **Next decision:** after the 7 L1 defects are fixed, the default is decided again.
