import { DEFAULT_CHECKPOINT_TIMEOUT_SECONDS } from "@roo-code/types"

import type { ExtensionStateContextType } from "@src/context/ExtensionStateContext"

export type UpdatedSettings = Record<string, unknown>

/**
 * The `updateSettings` payload that the settings view would write for `state`. Save does not send
 * this whole object: it sends only diffUpdatedSettings() against the payload of the state the view
 * loaded, so a view that has been open a while cannot revert newer stored settings.
 */
export function buildUpdatedSettings(state: ExtensionStateContextType): UpdatedSettings {
	const {
		alwaysAllowAll,
		alwaysAllowReadOnly,
		alwaysAllowReadOnlyOutsideWorkspace,
		allowedCommands,
		deniedCommands,
		allowedMaxRequests,
		allowedMaxCost,
		language,
		alwaysAllowBrowser,
		alwaysAllowComputerUse,
		computerUseEnabled,
		computerUseAllowedApps,
		computerUseBackgroundMode,
		alwaysAllowExecute,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		alwaysAllowSubtasks,
		alwaysAllowNestedSubtasks,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		autoCondenseContext,
		allowOverflowTruncation,
		pruneToolResultsOnOverflow,
		offloadImagesOnOverflow,
		architectureContextMode,
		architectureDecisionApproval,
		architectureBootstrap,
		cordisTextOnlyTurnPolicy,
		taskProfile,
		parallelSubtasksConcurrency,
		parallelSubtasksTokenBudget,
		autoCondenseContextPercent,
		browserToolEnabled,
		browserViewportSize,
		browserHeaded,
		browserLocalBrowser,
		enableCheckpoints,
		checkpointTimeout,
		experiments,
		maxOpenTabsContext,
		maxWorkspaceFiles,
		remoteBrowserHost,
		screenshotQuality,
		soundEnabled,
		ttsEnabled,
		ttsSpeed,
		soundVolume,
		terminalOutputPreviewSize,
		terminalShellIntegrationTimeout,
		terminalShellIntegrationDisabled,
		terminalCommandDelay,
		terminalPowershellCounter,
		terminalZshClearEolMark,
		terminalZshOhMy,
		terminalZshP10k,
		terminalZdotdir,
		writeDelayMs,
		showRooIgnoredFiles,
		enableSubfolderRules,
		remoteBrowserEnabled,
		maxImageFileSize,
		maxTotalImageSize,
		customSupportPrompts,
		profileThresholds,
		alwaysAllowFollowupQuestions,
		followupAutoApproveTimeoutMs,
		includeDiagnosticMessages,
		maxDiagnosticMessages,
		includeTaskHistoryInEnhance,
		imageGenerationProvider,
		braveApiKey,
		context7ApiKey,
		githubToken,
		nativeToolEnabled,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		liteLlmImageApiKey,
		liteLlmImageBaseUrl,
		liteLlmImageGenerationSelectedModel,
		liteLlmImageEditingSelectedModel,
		liteLlmVideoGenerationSelectedModel,
		reasoningBlockCollapsed,
		enterBehavior,
		includeCurrentTime,
		includeCurrentCost,
		maxGitStatusFiles,
	} = state

	return {
		language,
		alwaysAllowAll: alwaysAllowAll ?? undefined,
		alwaysAllowReadOnly: alwaysAllowReadOnly ?? undefined,
		alwaysAllowReadOnlyOutsideWorkspace: alwaysAllowReadOnlyOutsideWorkspace ?? undefined,
		alwaysAllowWrite: alwaysAllowWrite ?? undefined,
		alwaysAllowWriteOutsideWorkspace: alwaysAllowWriteOutsideWorkspace ?? undefined,
		alwaysAllowWriteProtected: alwaysAllowWriteProtected ?? undefined,
		alwaysAllowExecute: alwaysAllowExecute ?? undefined,
		alwaysAllowBrowser: alwaysAllowBrowser ?? undefined,
		alwaysAllowComputerUse: alwaysAllowComputerUse ?? false,
		computerUseEnabled: computerUseEnabled ?? false,
		computerUseAllowedApps: computerUseAllowedApps ?? [],
		computerUseBackgroundMode: computerUseBackgroundMode ?? false,
		alwaysAllowMcp,
		alwaysAllowModeSwitch,
		allowedCommands: allowedCommands ?? [],
		deniedCommands: deniedCommands ?? [],
		// Note that we use `null` instead of `undefined` since `JSON.stringify`
		// will omit `undefined` when serializing the object and passing it to the
		// extension host. We may need to do the same for other nullable fields.
		allowedMaxRequests: allowedMaxRequests ?? null,
		allowedMaxCost: allowedMaxCost ?? null,
		autoCondenseContext,
		allowOverflowTruncation: allowOverflowTruncation ?? true,
		pruneToolResultsOnOverflow: pruneToolResultsOnOverflow ?? true,
		offloadImagesOnOverflow: offloadImagesOnOverflow ?? true,
		architectureContextMode: architectureContextMode ?? "off",
		architectureDecisionApproval: architectureDecisionApproval ?? "user",
		architectureBootstrap: architectureBootstrap ?? true,
		cordisTextOnlyTurnPolicy: cordisTextOnlyTurnPolicy ?? "retryThenPause",
		taskProfile,
		parallelSubtasksConcurrency,
		parallelSubtasksTokenBudget,
		autoCondenseContextPercent,
		browserToolEnabled: browserToolEnabled ?? true,
		soundEnabled: soundEnabled ?? true,
		soundVolume: soundVolume ?? 0.5,
		ttsEnabled,
		ttsSpeed,
		enableCheckpoints: enableCheckpoints ?? false,
		checkpointTimeout: checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
		browserViewportSize: browserViewportSize ?? "900x600",
		browserHeaded: browserHeaded ?? false,
		browserLocalBrowser: browserLocalBrowser ?? "chromium",
		remoteBrowserHost: remoteBrowserEnabled ? remoteBrowserHost : undefined,
		remoteBrowserEnabled: remoteBrowserEnabled ?? false,
		writeDelayMs,
		screenshotQuality: screenshotQuality ?? 75,
		terminalShellIntegrationTimeout: terminalShellIntegrationTimeout ?? 30_000,
		terminalShellIntegrationDisabled,
		terminalCommandDelay,
		terminalPowershellCounter,
		terminalZshClearEolMark,
		terminalZshOhMy,
		terminalZshP10k,
		terminalZdotdir,
		terminalOutputPreviewSize: terminalOutputPreviewSize ?? "medium",
		maxOpenTabsContext: Math.min(Math.max(0, maxOpenTabsContext ?? 20), 500),
		maxWorkspaceFiles: Math.min(Math.max(0, maxWorkspaceFiles ?? 200), 500),
		showRooIgnoredFiles: showRooIgnoredFiles ?? true,
		enableSubfolderRules: enableSubfolderRules ?? false,
		maxImageFileSize: maxImageFileSize ?? 5,
		maxTotalImageSize: maxTotalImageSize ?? 20,
		includeDiagnosticMessages: includeDiagnosticMessages !== undefined ? includeDiagnosticMessages : true,
		maxDiagnosticMessages: maxDiagnosticMessages ?? 50,
		alwaysAllowSubtasks,
		alwaysAllowNestedSubtasks,
		managedEnvironmentsEnabled: state.managedEnvironmentsEnabled,
		alwaysAllowManagedEnvironments: state.alwaysAllowManagedEnvironments,
		managedEnvironmentsRoot: state.managedEnvironmentsRoot,
		managedEnvironmentsPythonPath: state.managedEnvironmentsPythonPath,
		managedEnvironmentsMaxDownloadMb: state.managedEnvironmentsMaxDownloadMb,
		managedEnvironmentsMaxDiskMb: state.managedEnvironmentsMaxDiskMb,
		managedEnvironmentsTimeoutSeconds: state.managedEnvironmentsTimeoutSeconds,
		alwaysAllowFollowupQuestions: alwaysAllowFollowupQuestions ?? false,
		followupAutoApproveTimeoutMs,
		includeTaskHistoryInEnhance: includeTaskHistoryInEnhance ?? true,
		reasoningBlockCollapsed: reasoningBlockCollapsed ?? true,
		enterBehavior: enterBehavior ?? "send",
		includeCurrentTime: includeCurrentTime ?? true,
		includeCurrentCost: includeCurrentCost ?? true,
		maxGitStatusFiles: maxGitStatusFiles ?? 0,
		profileThresholds,
		imageGenerationProvider,
		braveApiKey,
		context7ApiKey,
		githubToken,
		nativeToolEnabled,
		openRouterImageApiKey,
		openRouterImageGenerationSelectedModel,
		liteLlmImageApiKey,
		liteLlmImageBaseUrl,
		liteLlmImageGenerationSelectedModel,
		liteLlmImageEditingSelectedModel,
		liteLlmVideoGenerationSelectedModel,
		experiments,
		customSupportPrompts,
	}
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === undefined || b === undefined) return false
	return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Returns only the keys of `current` that differ from `baseline`. `experiments` is compared per
 * experiment, and only the changed experiments are sent: the extension merges them into the stored
 * object, so experiments changed elsewhere are kept.
 */
export function diffUpdatedSettings(baseline: UpdatedSettings, current: UpdatedSettings): UpdatedSettings {
	const changed: UpdatedSettings = {}
	for (const [key, value] of Object.entries(current)) {
		if (key === "experiments") {
			const before = (baseline.experiments ?? {}) as Record<string, unknown>
			const after = (value ?? {}) as Record<string, unknown>
			const experiments: Record<string, unknown> = {}
			for (const [id, enabled] of Object.entries(after)) {
				if (!sameValue(before[id], enabled)) experiments[id] = enabled
			}
			if (Object.keys(experiments).length > 0) changed.experiments = experiments
			continue
		}
		if (!sameValue(baseline[key], value)) changed[key] = value
	}
	return changed
}
