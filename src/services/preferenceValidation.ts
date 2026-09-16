/**
 * Runtime validation for values read from the native preference stores.
 *
 * This module intentionally has no runtime dependency on `preferences.ts`.
 * The preference facade can pass its string key and default value here without
 * creating an import cycle while still rejecting malformed JSON values before
 * callers use them as typed data.
 */

import type { PrefKey } from './preferences';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isString = (value: unknown): value is string => typeof value === 'string';

const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;

const isNonNegativeInteger = (value: unknown): value is number =>
  isNonNegativeFiniteNumber(value) && Number.isInteger(value);

const isTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && Number.isFinite(Date.parse(value));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const isNullableStringRecord = (value: unknown): value is UnknownRecord =>
  isRecord(value) && Object.entries(value).every(
    ([key, entry]) => isNonEmptyString(key) && (entry === null || isString(entry)),
  );

const isNonEmptyStringRecord = (value: unknown): value is UnknownRecord =>
  isRecord(value) && Object.entries(value).every(
    ([key, entry]) => isNonEmptyString(key) && isNonEmptyString(entry),
  );

const isAppMode = (value: unknown): boolean =>
  value === 'Architect' || value === 'Implement' || value === 'Chat';

const isViewFilterRecord = (value: unknown): value is UnknownRecord => isRecord(value);

const isRememberedProject = (value: unknown): boolean => {
  if (!isRecord(value)) return false;

  return (
    isNonEmptyString(value.projectId) &&
    (value.groupId === null || isNonEmptyString(value.groupId)) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.lastOpenedAt)
  );
};

const isRememberedProjectArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isRememberedProject);

const isAIContextSelections = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (value.version !== undefined && value.version !== 1 && value.version !== 2) return false;

  return (
    (value.modeSelections === undefined || isRecord(value.modeSelections)) &&
    (value.conversationSelections === undefined || isRecord(value.conversationSelections)) &&
    (value.providerSelectionsByConversationId === undefined || isRecord(value.providerSelectionsByConversationId)) &&
    (value.providerSelectionsByMode === undefined || isRecord(value.providerSelectionsByMode))
  );
};

const isNotificationLevel = (value: unknown): boolean =>
  value === 'info' || value === 'warning' || value === 'error';

const isNotificationVariant = (value: unknown): boolean =>
  value === 'informational' || value === 'actionable';

const isNotificationCategory = (value: unknown): boolean =>
  value === 'task_attention_required' ||
  value === 'task_run_completed' ||
  value === 'task_completed' ||
  value === 'git_sync_completed' ||
  value === 'git_sync_attention_required';

const isWorkflowNotificationNavigation = (value: unknown): boolean => {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) return false;

  if (value.kind === 'conversation') {
    return (
      (value.requestKind === 'approval' || value.requestKind === 'questionnaire') &&
      isNonEmptyString(value.conversationId)
    );
  }

  if (value.kind !== 'review' || !isNonEmptyString(value.taskId)) return false;
  if ('catalogLoadId' in value && !isNonEmptyString(value.catalogLoadId)) return false;

  if (!('catalogScope' in value)) return true;
  if (!isRecord(value.catalogScope)) return false;

  return (
    'selectedGroupId' in value.catalogScope &&
    'selectedProjectId' in value.catalogScope &&
    (value.catalogScope.selectedGroupId === null ||
      isNonEmptyString(value.catalogScope.selectedGroupId)) &&
    (value.catalogScope.selectedProjectId === null ||
      isNonEmptyString(value.catalogScope.selectedProjectId))
  );
};

const isNotificationCenterItem = (value: unknown): boolean => {
  if (!isRecord(value)) return false;

  if (
    !isNonEmptyString(value.id) ||
    !isNotificationLevel(value.level) ||
    !isNotificationVariant(value.variant) ||
    !isNonEmptyString(value.title) ||
    !isTimestamp(value.createdAt) ||
    !('readAt' in value) ||
    !(value.readAt === null || isTimestamp(value.readAt))
  ) {
    return false;
  }

  if ('description' in value && !isString(value.description)) return false;
  if ('category' in value && value.category !== undefined && !isNotificationCategory(value.category)) {
    return false;
  }
  if ('workflowNavigation' in value &&
      value.workflowNavigation !== undefined &&
      !isWorkflowNotificationNavigation(value.workflowNavigation)) {
    return false;
  }

  return true;
};

const isNotificationCenterItemArray = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isNotificationCenterItem);

const isNotificationChannelMode = (value: unknown): boolean =>
  value === 'off' || value === 'toast' || value === 'desktop' || value === 'both';

const NOTIFICATION_CATEGORIES = [
  'task_attention_required',
  'task_run_completed',
  'task_completed',
  'git_sync_completed',
  'git_sync_attention_required',
] as const;

const isNotificationChannelModes = (value: unknown): boolean =>
  isRecord(value) && Object.entries(value).every(
    ([key, entry]) =>
      !(NOTIFICATION_CATEGORIES as readonly string[]).includes(key) ||
      isNotificationChannelMode(entry),
  );

const isOnboardingState = (value: unknown): boolean => {
  if (!isRecord(value) || value.version !== 1) return false;

  return (
    'completedAt' in value &&
    (value.completedAt === null || isTimestamp(value.completedAt)) &&
    'dismissedAt' in value &&
    (value.dismissedAt === null || isTimestamp(value.dismissedAt)) &&
    'lastStepId' in value &&
    (value.lastStepId === null || isNonEmptyString(value.lastStepId))
  );
};

const isPendingUpdateReleaseNote = (value: unknown): boolean => {
  if (value === null) return true;
  if (!isRecord(value)) return false;

  return isNonEmptyString(value.version) && isNonEmptyString(value.content);
};

const isModelConfig = (value: unknown): boolean => {
  if (value === null) return true;
  if (!isRecord(value)) return false;

  if (value.mode === 'conversation') return true;
  if (value.mode !== undefined && value.mode !== 'dedicated') return false;

  return (
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.modelId) &&
    (value.reasoningEffort === undefined ||
      value.reasoningEffort === null ||
      isString(value.reasoningEffort))
  );
};

const isCompatibleWithDefault = (value: unknown, defaultValue: unknown): boolean => {
  if (defaultValue === null) return value === null;
  if (Array.isArray(defaultValue)) return Array.isArray(value);
  if (isRecord(defaultValue)) return isRecord(value);
  return typeof value === typeof defaultValue;
};

/**
 * Return whether a value can safely be handed to a caller typed for `key`.
 * `defaultValue` is used as a shape fallback for a newly added key whose
 * specialized validator has not been added yet.
 */
export const isPreferenceValueValid = (
  key: PrefKey,
  value: unknown,
  defaultValue: unknown,
): boolean => {
  switch (key) {
    case 'windowWidth':
    case 'windowHeight':
    case 'leftPanelWidth':
    case 'architectLeftPanelWidth':
    case 'rightPanelWidth':
    case 'uiZoomLevel':
    case 'terminalPanelHeight':
      return isFiniteNumber(value);

    case 'windowX':
    case 'windowY':
      return value === null || isFiniteNumber(value);

    case 'windowBootstrapVersion':
      return isNonNegativeInteger(value);

    case 'isMaximized':
    case 'isLeftPanelOpen':
    case 'isRightPanelOpen':
    case 'compaction.auto':
    case 'compaction.prune':
    case 'compaction.manualVisible':
    case 'architectSyncTargetBeforeFinish':
    case 'metadataAutoPush':
    case 'inAppNotificationsEnabled':
    case 'speech.enhancementEnabled':
      return typeof value === 'boolean';

    case 'theme':
    case 'nativeMacosTitlebarBg':
    case 'architectGitBaseBranch':
    case 'architectGitMainBranch':
    case 'architectPlanBranchTemplate':
    case 'architectFeatureBranchTemplate':
    case 'architectStandaloneFeatureBranchTemplate':
    case 'architectReleaseBranchTemplate':
    case 'architectHotfixBranchTemplate':
    case 'architectBugfixBranchTemplate':
    case 'projectOpenEditorCommand':
    case 'projectOpenTerminalCommand':
    case 'projectOpenFilesCommand':
    case 'promptArchitect':
    case 'promptImplement':
    case 'promptChat':
    case 'promptPlanExplorer':
    case 'promptTaskReviewer':
    case 'promptRepoAuditor':
    case 'promptGoalAuditor':
    case 'smartCommitPrompt':
      return isString(value);

    case 'language':
      return value === 'en' ||
        value === 'fr' ||
        value === 'es' ||
        value === 'de' ||
        value === 'ja' ||
        value === 'ko';

    case 'uiZoomMode':
      return value === 'auto' || value === 'override';

    case 'codeOverflowMode':
      return value === 'wrap' || value === 'horizontal_scroll';

    case 'shortcutBindings':
      return isNullableStringRecord(value);

    case 'promptHistoryNavigationMode':
      return value === 'contextual_arrows' || value === 'shortcut_only';

    case 'activeTurnSendBehavior':
      return value === 'steer' || value === 'queue';

    case 'lastSelectedGroupId':
    case 'lastSelectedProjectId':
    case 'lastOpenProjectPath':
    case 'terminalActiveTabId':
      return isNullableString(value);

    case 'lastActiveMode':
      return isAppMode(value);

    case 'agentType':
      return value === 'build' || value === 'plan';

    case 'recentProjects':
    case 'macroEnabledProjects':
      return isRememberedProjectArray(value);

    case 'architectPinnedPlanIds':
    case 'architectNavigatorExpandedScopeIds':
    case 'chatArchivedConversationIds':
    case 'releaseNotesSeenVersions':
      return isStringArray(value);

    case 'implementViewFilters':
    case 'architectViewFilters':
    case 'chatViewFilters':
      // The view-filter store owns field-level normalization and migration.
      return isViewFilterRecord(value);

    case 'aiContextSelections':
      return isAIContextSelections(value);

    case 'chatMaxTurns':
      return value === null || (
        isFiniteNumber(value) &&
        Number.isInteger(value) &&
        value >= 3 &&
        value <= 50
      );

    case 'compaction.reservedTokens':
      return value === null || isNonNegativeFiniteNumber(value);

    case 'toolRiskLevel':
      return value === 'strict' || value === 'balanced' || value === 'yolo';

    case 'implementDiffPresentationMode':
      return value === 'focused' || value === 'full';

    case 'notificationChannelModes':
      return isNotificationChannelModes(value);

    case 'architectCompletionMergePolicy':
      return value === 'merge_commit' || value === 'fast_forward';

    case 'metadataMissingUpstreamPolicy':
      return value === 'ask' || value === 'ignore';

    case 'projectSwitchPolicy':
      return value === 'resume_per_project' || value === 'reset_on_switch';

    case 'terminalLastManualProjectByTask':
      return isNonEmptyStringRecord(value);

    case 'notificationCenterItems':
      return isNotificationCenterItemArray(value);

    case 'nativeMacosTitlebarTheme':
      return value === null || value === 'light' || value === 'dark';

    case 'projectOpenEditorApp':
    case 'projectOpenTerminalApp':
    case 'projectOpenFilesApp':
      return isNullableString(value);

    case 'onboardingState':
      return isOnboardingState(value);

    case 'releaseNotesPendingUpdate':
      return isPendingUpdateReleaseNote(value);

    case 'updateChannel':
      return value === 'stable' || value === 'preview';

    case 'metadataModelConfig':
    case 'smartCommitModelConfig':
      return isModelConfig(value);

    case 'speech.providerId':
    case 'speech.language':
      return isString(value);

    case 'speech.maxDurationSeconds':
      return isFiniteNumber(value) && value >= 10 && value <= 600;

    default:
      return isCompatibleWithDefault(value, defaultValue);
  }
};
