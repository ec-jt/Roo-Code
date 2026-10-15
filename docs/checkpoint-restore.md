# Checkpoint restore options

The checkpoint restore menu has three choices:

| Choice                 | Conversation history              | Workspace files        |
| ---------------------- | --------------------------------- | ---------------------- |
| Restore files          | Keep current history              | Restore the checkpoint |
| Restore task only      | Rewind to the checkpoint boundary | Keep current files     |
| Restore files and task | Rewind to the checkpoint boundary | Restore the checkpoint |

**Restore task only** requires confirmation because it removes later conversation messages from the current task. It is an in-place rewind, not a separate recovery branch. Context summaries and truncation markers removed by the rewind are cleaned up through the normal history-rewind path.

Stop execution and active terminals first. If prompted, reopen the task from History without resuming it. Task-only restore refuses an active edit or request rather than canceling an edit that could revert workspace files. After restoration, use the normal resume prompt to continue.

Task-only restore does not call the Git checkpoint restore service, restore managed environments, or mark the selected Git commit as the current workspace state. It can rewind history even if the old Git object is unavailable, provided the conversation checkpoint entry still exists.

Current files can contain changes made after the restored conversation boundary. Review them before continuing. Completed external actions are not undone. This option does not recreate or rewind a completed child task's own history or files.

Use **Recover in new branch** on a context-management event instead when you need to preserve the original conversation and create a separate recovery task. That action requires an exact pre-event snapshot.
