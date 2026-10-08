# Background activity

The **Background activity** accordion sits at the bottom of Chat beside the file-change section, above the prompt area. It is also available in History. It starts collapsed and shows active/total command counts and the current task status in its header. Expand it for the task controls and command status, elapsed time, working directory, launching task ID, terminal ID, exit code when known, and recent output. The expanded area has a bounded height and scrolls internally. An empty monitor is hidden.

- **Show terminal** reveals the original VS Code terminal only while its execution identity still matches.
- **Stop command** requires confirmation and rechecks execution identity afterward. VS Code terminals receive an interrupt; Execa uses its existing abort mechanism. Stop requested is not proof that the process exited.
- Output tails are independent of the output buffer sent to the model. Opening the panel does not consume pending model output.
- Roo receives a bounded activity summary in subsequent task context. It includes active/unknown executions and a few recent exits, so it can avoid launching duplicate work. The model does not receive continuous updates while a provider request is in flight.

The scope is commands launched through Roo terminal execution in the current workspace, plus the current task's explicitly launched commands outside it. Ownership is recorded when execution begins and survives task release. This is not a machine-wide process monitor. User-created commands, detached descendants, browser internals, and managed-environment installer subprocesses are not separately enumerated. Managed installation remains visible as the active task's work, not as a process row.

Unknown status is used when exit cannot be verified, including missing shell integration or terminal closure without an exit event. Do not infer termination from a task cancellation or a closed terminal. Stale controls cannot act on a newer execution in a reused terminal.

Activity history is in memory for the extension session. All active entries and up to 50 inactive/unknown entries are retained. Output tails are limited to 8 KiB per execution. Known credential formats receive best-effort redaction; output may still contain sensitive information. No logs are uploaded by the panel. Reloading the extension host loses tracking and does not discover previously detached processes.

The panel does not approve tools, run another Roo task, restart a service, or change existing command permissions. The first UI strings use English fallback. A live editor smoke test is required before treating the UI as release-validated.
