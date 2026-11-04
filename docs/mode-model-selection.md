# Mode changes and model selection

Included in 4.2.51 / Cordis preview 47.

Changing the mode of an open task changes its instructions and available tools, not its model or provider profile. The task keeps its active configuration, including unsaved overrides, whether the workspace profile lock is enabled or disabled. Selecting the current mode is a no-op.

Delegated children inherit a separate copy of the parent's active configuration even when the child uses a different mode. A queued next-request profile is not inherited. Inheritance protection remains active through mode changes; explicit profile selection can still replace the model.

To change an open task's model, explicitly select the intended provider profile or use the existing model-selection controls. Mode-associated profiles remain defaults when choosing a different mode with no task open. The workspace lock still prevents that pre-task default selection. Saved mode mappings are not deleted or migrated.

This change does not repair prior model selections or rewrite existing task data. Reopening tasks and restoring parents from stored profile names retain their existing behavior; this fix does not promise preservation of unsaved overrides across those separate restoration paths.
