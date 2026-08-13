import {
  SERVICE_ERROR_CODES,
  isPlanMetadataMissingError,
  isResourcePressureError,
  isWorkspaceStateUnavailableError,
  toServiceError,
  type ServiceError,
} from './contracts/errors';
import { isTooManyOpenFilesMessage } from './resourcePressureBackoff';
import type { MacroSyncNextAction, MacroSyncReason } from './tauriIpc';
import type { TranslationSchema } from '../i18n/resources';

export type DegradedErrorSeverity = 'info' | 'warning' | 'danger';

type StringLeafPaths<T> = {
  [Key in keyof T & string]: T[Key] extends string
    ? Key
    : T[Key] extends Readonly<Record<string, unknown>>
      ? `${Key}.${StringLeafPaths<T[Key]>}`
      : never;
}[keyof T & string];

export type DegradedErrorMessageKey =
  `errors.degraded.${StringLeafPaths<TranslationSchema['errors']['degraded']>}`;

export interface DegradedErrorMessage {
  key: DegradedErrorMessageKey;
  params?: Readonly<Record<string, string | number>>;
  fallbackKey: DegradedErrorMessageKey;
}

export type DegradedErrorTranslator = (
  key: string,
  options?: Readonly<Record<string, unknown>>
) => string;

export type DegradedErrorPrimaryAction =
  | 'retry'
  | 'repair_metadata'
  | 'configure_git'
  | 'open_project_settings'
  | 'resolve_conflicts'
  | 'use_ai_assistant'
  | 'commit_metadata'
  | 'sync_metadata';

export interface DegradedErrorPresentation {
  title: DegradedErrorMessage;
  body: DegradedErrorMessage;
  nextStep: DegradedErrorMessage | null;
  severity: DegradedErrorSeverity;
  technicalDetails: string | null;
  projectId?: string | null;
  repoPath?: string | null;
  primaryAction?: DegradedErrorPrimaryAction | null;
}

export interface ResolvedDegradedErrorPresentation
  extends Omit<DegradedErrorPresentation, 'title' | 'body' | 'nextStep'> {
  title: string;
  body: string;
  nextStep: string | null;
}

interface PresentServiceErrorOptions {
  fallbackBody?: string;
  projectId?: string | null;
  repoPath?: string | null;
}

const stringifyDetails = (value: unknown): string | null => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const serviceErrorMessage = (error: ServiceError): string =>
  error.message.trim();

const message = (
  key: DegradedErrorMessageKey,
  fallbackKey: DegradedErrorMessageKey,
  params?: DegradedErrorMessage['params']
): DegradedErrorMessage => ({ key, fallbackKey, ...(params ? { params } : {}) });

const title = (key: DegradedErrorMessageKey, params?: DegradedErrorMessage['params']) =>
  message(key, 'errors.degraded.fallback.title', params);

const body = (key: DegradedErrorMessageKey, params?: DegradedErrorMessage['params']) =>
  message(key, 'errors.degraded.fallback.body', params);

const nextStep = (key: DegradedErrorMessageKey, params?: DegradedErrorMessage['params']) =>
  message(key, 'errors.degraded.fallback.nextStep', params);

const dynamicBody = (value: string): DegradedErrorMessage =>
  body('errors.degraded.fallback.dynamic', { message: value });

export const resolveDegradedErrorMessage = (
  value: DegradedErrorMessage,
  translate: DegradedErrorTranslator
): string => {
  const resolved = translate(value.key, value.params);
  if (resolved.trim() && resolved !== value.key) return resolved;

  const fallback = translate(value.fallbackKey);
  return fallback.trim() && fallback !== value.fallbackKey ? fallback : '';
};

export const resolveDegradedErrorPresentation = (
  presentation: DegradedErrorPresentation,
  translate: DegradedErrorTranslator
): ResolvedDegradedErrorPresentation => ({
  ...presentation,
  title: resolveDegradedErrorMessage(presentation.title, translate),
  body: resolveDegradedErrorMessage(presentation.body, translate),
  nextStep: presentation.nextStep
    ? resolveDegradedErrorMessage(presentation.nextStep, translate)
    : null,
});

export const presentWorktreeError = (
  error: unknown,
  options: PresentServiceErrorOptions = {}
): DegradedErrorPresentation => {
  const normalized = toServiceError(error);
  const message = serviceErrorMessage(normalized);
  const lower = message.toLowerCase();

  if (lower.includes('still checked out') && lower.includes('uncommitted changes')) {
    return {
      title: title('errors.degraded.worktree.checkedOut.title'),
      body: body('errors.degraded.worktree.checkedOut.body'),
      nextStep: nextStep('errors.degraded.worktree.checkedOut.nextStep'),
      severity: 'danger',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (lower.includes('base branch') && lower.includes('does not exist')) {
    return {
      title: title('errors.degraded.worktree.missingBase.title'),
      body: body('errors.degraded.worktree.missingBase.body'),
      nextStep: nextStep('errors.degraded.worktree.missingBase.nextStep'),
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'configure_git',
    };
  }

  return {
    title: title('errors.degraded.worktree.fallback.title'),
    body: options.fallbackBody
      ? dynamicBody(options.fallbackBody)
      : body('errors.degraded.worktree.fallback.body'),
    nextStep: nextStep('errors.degraded.worktree.fallback.nextStep'),
    severity: 'warning',
    technicalDetails: stringifyDetails(normalized.details) || message,
    projectId: options.projectId ?? null,
    repoPath: options.repoPath ?? null,
    primaryAction: 'retry',
  };
};

export const presentReadOnlyProjectIssue = (params: {
  projectName?: string | null;
  projectId?: string | null;
  repoPath?: string | null;
  reason?: string | null;
}): DegradedErrorPresentation => ({
  title: title('errors.degraded.readOnly.title'),
  body: params.projectName
    ? body('errors.degraded.readOnly.namedBody', { projectName: params.projectName })
    : body('errors.degraded.readOnly.body'),
  nextStep:
    params.reason === 'missing_git'
      ? nextStep('errors.degraded.readOnly.missingGitNextStep')
      : nextStep('errors.degraded.readOnly.settingsNextStep'),
  severity: 'warning',
  technicalDetails: params.reason || null,
  projectId: params.projectId ?? null,
  repoPath: params.repoPath ?? null,
  primaryAction: params.reason === 'missing_git' ? 'configure_git' : 'open_project_settings',
});

export const presentReplicaIssue = (params: {
  reason: 'content_diverged' | 'missing_replica';
  planId: string;
  missingCount?: number;
  technicalMessage?: string | null;
}): DegradedErrorPresentation => {
  if (params.reason === 'missing_replica') {
    const count = params.missingCount ?? 1;
    return {
      title: title(
        count === 1
          ? 'errors.degraded.replica.missing.titleSingular'
          : 'errors.degraded.replica.missing.titlePlural',
        { count }
      ),
      body: body('errors.degraded.replica.missing.body'),
      nextStep: nextStep('errors.degraded.replica.missing.nextStep'),
      severity: 'danger',
      technicalDetails: params.technicalMessage || `Plan ${params.planId} has missing metadata replicas.`,
      primaryAction: 'repair_metadata',
    };
  }

  return {
    title: title('errors.degraded.replica.diverged.title'),
    body: body('errors.degraded.replica.diverged.body'),
    nextStep: nextStep('errors.degraded.replica.diverged.nextStep'),
    severity: 'danger',
    technicalDetails: params.technicalMessage || `Plan ${params.planId} has divergent metadata replicas.`,
    primaryAction: 'repair_metadata',
  };
};

export const presentGitFlowBlockingIssue = (params: {
  blockingKind?: 'repository_dirty' | 'merge_conflict' | 'merge_in_progress' | null;
  reason?: string | null;
  repoPath?: string | null;
  conflictFiles?: string[];
}): DegradedErrorPresentation => {
  if (params.blockingKind === 'repository_dirty') {
    return {
      title: title('errors.degraded.gitFlow.repositoryDirty.title'),
      body: body('errors.degraded.gitFlow.repositoryDirty.body'),
      nextStep: nextStep('errors.degraded.gitFlow.repositoryDirty.nextStep'),
      severity: 'warning',
      technicalDetails: params.reason || null,
      repoPath: params.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (params.blockingKind === 'merge_in_progress') {
    return {
      title: title('errors.degraded.gitFlow.mergeInProgress.title'),
      body: body('errors.degraded.gitFlow.mergeInProgress.body'),
      nextStep: nextStep('errors.degraded.gitFlow.mergeInProgress.nextStep'),
      severity: 'danger',
      technicalDetails: params.reason || null,
      repoPath: params.repoPath ?? null,
      primaryAction: 'resolve_conflicts',
    };
  }

  return {
    title: title('errors.degraded.gitFlow.conflict.title'),
    body: body('errors.degraded.gitFlow.conflict.body'),
    nextStep:
      params.conflictFiles && params.conflictFiles.length > 0
        ? nextStep('errors.degraded.gitFlow.conflict.filesNextStep')
        : nextStep('errors.degraded.gitFlow.conflict.blockersNextStep'),
    severity: 'danger',
    technicalDetails: params.reason || null,
    repoPath: params.repoPath ?? null,
    primaryAction: 'use_ai_assistant',
  };
};

const METADATA_REASON_COPY: Record<MacroSyncReason, Pick<DegradedErrorPresentation, 'title' | 'body' | 'nextStep' | 'primaryAction' | 'severity'>> = {
  clean: {
    title: title('errors.degraded.metadata.clean.title'),
    body: body('errors.degraded.metadata.clean.body'),
    nextStep: null,
    primaryAction: null,
    severity: 'info',
  },
  dirty: {
    title: title('errors.degraded.metadata.dirty.title'),
    body: body('errors.degraded.metadata.dirty.body'),
    nextStep: nextStep('errors.degraded.metadata.dirty.nextStep'),
    primaryAction: 'commit_metadata',
    severity: 'warning',
  },
  ahead: {
    title: title('errors.degraded.metadata.ahead.title'),
    body: body('errors.degraded.metadata.ahead.body'),
    nextStep: nextStep('errors.degraded.metadata.ahead.nextStep'),
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  behind: {
    title: title('errors.degraded.metadata.behind.title'),
    body: body('errors.degraded.metadata.behind.body'),
    nextStep: nextStep('errors.degraded.metadata.behind.nextStep'),
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  diverged: {
    title: title('errors.degraded.metadata.diverged.title'),
    body: body('errors.degraded.metadata.diverged.body'),
    nextStep: nextStep('errors.degraded.metadata.diverged.nextStep'),
    primaryAction: 'resolve_conflicts',
    severity: 'danger',
  },
  merge_conflict: {
    title: title('errors.degraded.metadata.mergeConflict.title'),
    body: body('errors.degraded.metadata.mergeConflict.body'),
    nextStep: nextStep('errors.degraded.metadata.mergeConflict.nextStep'),
    primaryAction: 'use_ai_assistant',
    severity: 'danger',
  },
  missing_origin: {
    title: title('errors.degraded.metadata.missingOrigin.title'),
    body: body('errors.degraded.metadata.missingOrigin.body'),
    nextStep: nextStep('errors.degraded.metadata.missingOrigin.nextStep'),
    primaryAction: 'configure_git',
    severity: 'warning',
  },
  missing_upstream: {
    title: title('errors.degraded.metadata.missingUpstream.title'),
    body: body('errors.degraded.metadata.missingUpstream.body'),
    nextStep: nextStep('errors.degraded.metadata.missingUpstream.nextStep'),
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  auth_required: {
    title: title('errors.degraded.metadata.authRequired.title'),
    body: body('errors.degraded.metadata.authRequired.body'),
    nextStep: nextStep('errors.degraded.metadata.authRequired.nextStep'),
    primaryAction: 'configure_git',
    severity: 'warning',
  },
  network_error: {
    title: title('errors.degraded.metadata.networkError.title'),
    body: body('errors.degraded.metadata.networkError.body'),
    nextStep: nextStep('errors.degraded.metadata.networkError.nextStep'),
    primaryAction: 'retry',
    severity: 'warning',
  },
  unknown_error: {
    title: title('errors.degraded.metadata.unknownError.title'),
    body: body('errors.degraded.metadata.unknownError.body'),
    nextStep: nextStep('errors.degraded.metadata.unknownError.nextStep'),
    primaryAction: 'retry',
    severity: 'danger',
  },
};

export const presentMetadataSyncIssue = (params: {
  reason?: MacroSyncReason | null;
  nextAction?: MacroSyncNextAction | null;
  error?: string | null;
  repoPath?: string | null;
}): DegradedErrorPresentation => {
  const reason = params.reason || 'unknown_error';
  const copy = METADATA_REASON_COPY[reason] || METADATA_REASON_COPY.unknown_error;
  return {
    ...copy,
    repoPath: params.repoPath ?? null,
    technicalDetails: params.error || reason,
    primaryAction:
      params.nextAction === 'resolve_conflict'
        ? 'use_ai_assistant'
        : copy.primaryAction,
  };
};

export const presentServiceError = (
  error: unknown,
  options: PresentServiceErrorOptions = {}
): DegradedErrorPresentation => {
  const normalized = toServiceError(error);
  const message = serviceErrorMessage(normalized);
  const lower = message.toLowerCase();

  if (isResourcePressureError(normalized) || isTooManyOpenFilesMessage(message)) {
    return {
      title: title('errors.degraded.service.resourcePressure.title'),
      body: body('errors.degraded.service.resourcePressure.body'),
      nextStep: nextStep('errors.degraded.service.resourcePressure.nextStep'),
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (
    normalized.code === SERVICE_ERROR_CODES.PLAN_REPLICA_DIVERGED ||
    lower.includes('diverged metadata replicas') ||
    lower.includes('missing metadata replicas')
  ) {
    return {
      title: title('errors.degraded.service.replicaRepair.title'),
      body: body('errors.degraded.service.replicaRepair.body'),
      nextStep: nextStep('errors.degraded.service.replicaRepair.nextStep'),
      severity: 'danger',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'repair_metadata',
    };
  }

  if (isPlanMetadataMissingError(normalized)) {
    return {
      title: title('errors.degraded.service.metadataMissing.title'),
      body: body('errors.degraded.service.metadataMissing.body'),
      nextStep: nextStep('errors.degraded.service.metadataMissing.nextStep'),
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'repair_metadata',
    };
  }

  if (isWorkspaceStateUnavailableError(normalized)) {
    return {
      title: title('errors.degraded.service.workspaceUnavailable.title'),
      body: body('errors.degraded.service.workspaceUnavailable.body'),
      nextStep: nextStep('errors.degraded.service.workspaceUnavailable.nextStep'),
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (lower.includes('worktree') || lower.includes('branch is still checked out') || lower.includes('base branch')) {
    return presentWorktreeError(normalized, options);
  }

  if (lower.includes('read-only') || lower.includes('git is not ready') || lower.includes('repository path is missing')) {
    return {
      title: title('errors.degraded.service.gitNotReady.title'),
      body: body('errors.degraded.service.gitNotReady.body'),
      nextStep: nextStep('errors.degraded.service.gitNotReady.nextStep'),
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'open_project_settings',
    };
  }

  return {
    title: title('errors.degraded.service.fallback.title'),
    body: dynamicBody(options.fallbackBody || message),
    nextStep: nextStep('errors.degraded.service.fallback.nextStep'),
    severity: 'danger',
    technicalDetails: stringifyDetails(normalized.details) || message,
    projectId: options.projectId ?? null,
    repoPath: options.repoPath ?? null,
    primaryAction: 'retry',
  };
};
