# Subtask handoffs

## Implementation first

Direct implementation is the default. Multiple or nested subtasks are for a concrete independent deliverable or a specific blocker, not a task-count requirement or another review layer. Existing nested-delegation approval and permission checks still apply.

Run tests and checks when required by the user or project rules, or necessary for a specific correctness, security, or integration risk. Prefer the smallest relevant check and reuse valid results from the current code state. Do not routinely run full test/lint/type/build cycles after each edit. Stop after delivering the requested work and necessary validation; report unverified areas instead of extending the task into repeated checking.

## Return useful context

Delegation and completion instructions ask children to return a self-contained handoff with essential facts, not just a success sentence. Applicable sections are:

- **Outcome:** completed, partial, or blocked, distinguishing implementation from verification.
- **Changes and findings:** affected files, evidence, conclusions, important decisions, and rejected approaches worth preserving.
- **Parent must check:** key files, symbols or line ranges, and existing artifacts. Each reference explains what it contains, why it matters, and what the parent must read or verify before integration or further delegation. Required checks are separate from optional background.
- **Validation:** commands, working directories, results, failures, and checks not run.
- **Remaining work:** risks, blockers, next actions, and completed work later subtasks should not repeat without a reason.

Essential conclusions belong in the completion itself. References supplement them rather than making the parent repeat the investigation. Children must not invent paths, expose secrets, or create report files when their assignment permits only reading. Temporary or unavailable artifacts must be identified as such.

The parent receives the complete child result with a reminder to inspect critical references when its permissions allow, preserve findings and validation limits, and carry completed work into later delegation briefs. Child recommendations do not grant wider permissions. Missing references must be reported rather than assumed to have been read.

The return mechanism does not automatically read referenced files or copy the child's entire transcript. Existing task-history delivery and retry deduplication remain in place. Structured sections are prompt guidance, not a schema-enforced guarantee of model compliance; the parent remains responsible for checking important claims.
