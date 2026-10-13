# Context recovery branches

Context compaction and truncation events have a **Recover in new branch** action. The action copies the exact history from immediately before that event into a separate standalone task. It does not undo the original task in place.

## Procedure

1. Stop active execution and terminals. If required, reopen the original task from History without resuming it.
2. Find the compaction or truncation card, including on an older history page.
3. Select **Recover in new branch**.
4. Choose a saved provider profile. The picker shows its provider and model.
5. Choose to compact the restored context or keep it uncompressed.
6. Open the new task in History, identified by the **[Context recovery]** prefix.
7. Inspect the restored history and current workspace before explicitly resuming.

The original parent, completed child, delegation metadata, and files remain unchanged. The branch retains the completed child's returned result when it was present before the selected event. It does not rerun the child. Later parent messages stay in the original task and are not copied into this branch. Earlier compactions remain part of the selected event's input.

The chosen profile is saved with the branch and used for optional compaction. Creating the branch does not change the original task's profile or start normal model execution. Compaction itself makes a model request and can incur a charge. If compaction returns an ordinary error, the restored branch remains available with that error and uncompressed history. A failed durable preparation leaves the branch blocked from resuming.

## Safety and limits

- Recovery uses an exact pre-event snapshot saved before context replacement. Events created by older extension versions have no such snapshot and cannot be recovered through this action. The extension refuses to guess their boundaries.
- Tool calls and results must pair completely. Recovery refuses ambiguous or unfinished tool exchanges instead of silently dropping a completed child's result.
- The branch has no parent/child ownership links. Its source task and event are recorded separately for provenance.
- Provider response-chain identifiers and source checkpoint references are not reused. Checkpoints are disabled for the recovery branch. This is not a filesystem rollback.
- Command-output artifacts are not copied. Historical references to external artifacts may remain unavailable in the branch.
- Snapshots contain task history, use the configured task storage directory, and consume additional disk space. They are removed with task-directory deletion.
- Restoring large uncompressed context can overflow again after an explicit resume. Select a model with sufficient input capacity or compact first.

## Codex orphan-result protection

The Codex request formatter now removes a function-call output when the outgoing request contains no matching function call. This avoids the corresponding provider rejection, but cannot recover a missing call or prove the cause of a historical error. Recovery branches use stricter validation and reject incomplete exchanges before request formatting.
