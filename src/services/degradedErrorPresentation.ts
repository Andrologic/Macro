import { toServiceError, type ServiceError } from './contracts/errors';
import type { MacroSyncNextAction, MacroSyncReason } from './tauriIpc';

export type DegradedErrorSeverity = 'info' | 'warning' | 'danger';

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
  title: string;
  body: string;
  nextStep: string | null;
  severity: DegradedErrorSeverity;
  technicalDetails: string | null;
  projectId?: string | null;
  repoPath?: string | null;
  primaryAction?: DegradedErrorPrimaryAction | null;
}

interface PresentServiceErrorOptions {
  fallbackTitle?: string;
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
  error.message.trim() || 'Unknown error';

export const presentWorktreeError = (
  error: unknown,
  options: PresentServiceErrorOptions = {}
): DegradedErrorPresentation => {
  const normalized = toServiceError(error);
  const message = serviceErrorMessage(normalized);
  const lower = message.toLowerCase();

  if (lower.includes('still checked out') && lower.includes('uncommitted changes')) {
    return {
      title: 'Macro could not prepare the task workspace',
      body: 'The branch needed for this task is still open in the main repository with local changes.',
      nextStep: 'Commit, stash, or discard those local changes, then retry the task.',
      severity: 'danger',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (lower.includes('base branch') && lower.includes('does not exist')) {
    return {
      title: 'Macro could not find the base branch',
      body: 'This task needs a base branch before its worktree can be created.',
      nextStep: 'Create the branch or update the project GitFlow settings, then retry.',
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'configure_git',
    };
  }

  return {
    title: options.fallbackTitle || 'Macro could not prepare the task workspace',
    body: options.fallbackBody || 'The task workspace is not ready yet, so Macro cannot safely review or edit files.',
    nextStep: 'Retry the task. If it still fails, open the project Git settings and check the repository state.',
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
  title: 'This project is available for reading only',
  body: `${params.projectName || 'This project'} can be used as context, but Macro cannot create branches, worktrees, commits, or merges there yet.`,
  nextStep:
    params.reason === 'missing_git'
      ? 'Initialize Git for this project, then enable editable work.'
      : 'Open project settings and make sure GitFlow is ready.',
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
      title: `Plan metadata is missing in ${count} ${count === 1 ? 'repository' : 'repositories'}`,
      body: 'Macro needs every expected plan metadata replica before it can safely update this plan.',
      nextStep: 'Repair the plan metadata, then retry the action.',
      severity: 'danger',
      technicalDetails: params.technicalMessage || `Plan ${params.planId} has missing metadata replicas.`,
      primaryAction: 'repair_metadata',
    };
  }

  return {
    title: 'Plan metadata differs between repositories',
    body: 'Macro found more than one version of this plan metadata and must choose a canonical copy before continuing.',
    nextStep: 'Repair from the newest replica unless you intentionally need an older copy.',
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
      title: 'Repository has local changes',
      body: 'Macro cannot finish this merge while the target repository has unrelated uncommitted changes.',
      nextStep: 'Commit, stash, or discard the local changes, then retry the merge.',
      severity: 'warning',
      technicalDetails: params.reason || null,
      repoPath: params.repoPath ?? null,
      primaryAction: 'retry',
    };
  }

  if (params.blockingKind === 'merge_in_progress') {
    return {
      title: 'A merge is already in progress',
      body: 'Macro found an unfinished merge in this repository.',
      nextStep: 'Finish or abort the existing merge, then retry.',
      severity: 'danger',
      technicalDetails: params.reason || null,
      repoPath: params.repoPath ?? null,
      primaryAction: 'resolve_conflicts',
    };
  }

  return {
    title: 'Resolve these conflicts before finishing',
    body: 'The plan cannot be merged cleanly yet.',
    nextStep:
      params.conflictFiles && params.conflictFiles.length > 0
        ? 'Resolve the listed files, then retry the merge.'
        : 'Resolve the merge blockers, then retry.',
    severity: 'danger',
    technicalDetails: params.reason || null,
    repoPath: params.repoPath ?? null,
    primaryAction: 'use_ai_assistant',
  };
};

const METADATA_REASON_COPY: Record<MacroSyncReason, Pick<DegradedErrorPresentation, 'title' | 'body' | 'nextStep' | 'primaryAction' | 'severity'>> = {
  clean: {
    title: '@macro metadata is up to date',
    body: 'No action is needed.',
    nextStep: null,
    primaryAction: null,
    severity: 'info',
  },
  dirty: {
    title: '@macro metadata has local changes',
    body: 'Macro needs to save metadata changes before syncing.',
    nextStep: 'Save @macro metadata, then retry the sync.',
    primaryAction: 'commit_metadata',
    severity: 'warning',
  },
  ahead: {
    title: '@macro metadata is ready to publish',
    body: 'Your local metadata branch has changes that are not on the remote yet.',
    nextStep: 'Push @macro when you are ready.',
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  behind: {
    title: '@macro metadata is behind remote',
    body: 'Remote metadata has updates that are not local yet.',
    nextStep: 'Pull @macro, then retry your action.',
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  diverged: {
    title: '@macro metadata has diverged',
    body: 'Local and remote metadata both changed.',
    nextStep: 'Pull @macro, resolve any conflicts, then push.',
    primaryAction: 'resolve_conflicts',
    severity: 'danger',
  },
  merge_conflict: {
    title: '@macro metadata has conflicts',
    body: 'The metadata branch has unresolved conflict files.',
    nextStep: 'Resolve the conflicted metadata files, then retry the same sync step.',
    primaryAction: 'use_ai_assistant',
    severity: 'danger',
  },
  missing_origin: {
    title: '@macro remote is not configured',
    body: 'Macro cannot sync metadata because the repository has no origin remote.',
    nextStep: 'Configure the Git remote, then retry.',
    primaryAction: 'configure_git',
    severity: 'warning',
  },
  missing_upstream: {
    title: '@macro has no upstream branch',
    body: 'The metadata branch exists locally but is not linked to a remote branch yet.',
    nextStep: 'Push @macro to publish it and set the upstream.',
    primaryAction: 'sync_metadata',
    severity: 'warning',
  },
  auth_required: {
    title: 'Git authentication is required',
    body: 'Macro cannot reach the metadata remote with the current credentials.',
    nextStep: 'Configure Git authentication, then retry.',
    primaryAction: 'configure_git',
    severity: 'warning',
  },
  network_error: {
    title: 'Metadata sync could not reach the remote',
    body: 'The network or remote service is unavailable right now.',
    nextStep: 'Check your connection, then retry.',
    primaryAction: 'retry',
    severity: 'warning',
  },
  unknown_error: {
    title: 'Macro metadata sync failed',
    body: 'Macro could not complete the metadata sync safely.',
    nextStep: 'Retry the sync. If it fails again, inspect the technical details.',
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

  if (lower.includes('worktree') || lower.includes('branch is still checked out') || lower.includes('base branch')) {
    return presentWorktreeError(normalized, options);
  }

  if (lower.includes('read-only') || lower.includes('git is not ready') || lower.includes('repository path is missing')) {
    return {
      title: 'This project is not ready for editable work',
      body: 'Macro can still use this project for context, but it cannot write to it until Git is ready.',
      nextStep: 'Open project settings and finish the Git setup.',
      severity: 'warning',
      technicalDetails: stringifyDetails(normalized.details) || message,
      projectId: options.projectId ?? null,
      repoPath: options.repoPath ?? null,
      primaryAction: 'open_project_settings',
    };
  }

  return {
    title: options.fallbackTitle || 'Something needs attention',
    body: options.fallbackBody || message,
    nextStep: 'Review the details, fix the blocking state, then retry.',
    severity: 'danger',
    technicalDetails: stringifyDetails(normalized.details) || message,
    projectId: options.projectId ?? null,
    repoPath: options.repoPath ?? null,
    primaryAction: 'retry',
  };
};
