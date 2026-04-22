import type {
  PlanFinalizationBlockingKind,
  PlanFinalizationNextAction,
  PlanReviewRepositoryResult,
  PlanReviewResult,
} from './architectGitFlowService';
import { toServiceError } from './contracts/errors';
import type { TaskExecutionTarget, TaskStatus } from '../types';

export type MergeWorkflowKind = 'task_completion' | 'plan_finalization';

export type MergeWorkflowPhase =
  | 'idle'
  | 'loading_review'
  | 'ready'
  | 'blocked'
  | 'merging'
  | 'archiving'
  | 'failed';

export type MergeWorkflowBlockingKind = PlanFinalizationBlockingKind;
export type MergeWorkflowNextAction = PlanFinalizationNextAction;

export interface MergeWorkflowRepositoryResult {
  id: string;
  projectId: string;
  repoPath: string;
  sourceBranchName: string;
  targetBranchName: string;
  isClean: boolean;
  hasChanges: boolean;
  mergeable: boolean;
  conflictFiles: string[];
  mergeInProgress: boolean;
  diff: string;
  checkStatus: 'not_run' | 'passed' | 'failed';
  blockingKind: MergeWorkflowBlockingKind | null;
  nextAction: MergeWorkflowNextAction | null;
  blockingReason: string | null;
}

export interface MergeWorkflowReviewContext {
  taskId: string;
  title: string;
  taskSource?: string | null;
  planId?: string | null;
  planTitle?: string | null;
  targetBranch?: string | null;
}

export interface MergeWorkflowRuntimeState {
  taskId: string;
  kind: MergeWorkflowKind;
  phase: MergeWorkflowPhase;
  taskStatus: TaskStatus;
  review: MergeWorkflowReviewContext | null;
  repositories: MergeWorkflowRepositoryResult[];
  blockedRepositories: MergeWorkflowRepositoryResult[];
  message: string | null;
  lastLoadedAt: string | null;
}

export interface MergeWorkflowViewState {
  phase: MergeWorkflowPhase | 'loading';
  isLoading: boolean;
  isBlocked: boolean;
  isFailed: boolean;
  isMerging: boolean;
  isArchiving: boolean;
  isBusy: boolean;
  canMerge: boolean;
  canRetry: boolean;
  canResolveAutomatically: boolean;
  canArchive: boolean;
}

export type MergeWorkflowIndicatorState =
  | 'merging'
  | 'merge_blocked'
  | 'merge_failed';

export interface MergeWorkflowBlockedState {
  taskId: string;
  kind: MergeWorkflowKind;
  message: string;
  repositories: MergeWorkflowRepositoryResult[];
  blockedRepositories: MergeWorkflowRepositoryResult[];
}

interface MergeWorkflowBlockedErrorLike extends Error {
  taskId: string;
  kind: MergeWorkflowKind;
  repositories: MergeWorkflowRepositoryResult[];
  blockedRepositories: MergeWorkflowRepositoryResult[];
}

interface MergeWorkflowFocusableTargetLike {
  projectId: string;
  repoPath?: string | null;
  branchName?: string | null;
  sourceBranchName?: string | null;
  targetBranchName?: string | null;
}

interface MergeWorkflowGitStatusLike {
  is_clean: boolean;
  conflicted_files?: string[];
  conflictedFiles?: string[];
  merge_in_progress?: boolean;
  mergeInProgress?: boolean;
}

interface MergeWorkflowMergeCheckLike {
  mergeable: boolean;
  conflictFiles: string[];
}

export const isRepositoryRootExecutionTarget = (
  target: Pick<TaskExecutionTarget, 'executionKind'>
): boolean => target.executionKind === 'repository_root';

export const resolveMergeWorkflowTaskStatus = (
  phase: MergeWorkflowPhase,
  params?: { kind?: MergeWorkflowKind }
): TaskStatus => {
  switch (phase) {
    case 'blocked':
      return 'Blocked';
    case 'merging':
    case 'archiving':
      return 'InProgress';
    case 'failed':
      return 'Failed';
    case 'idle':
    case 'loading_review':
      return params?.kind === 'plan_finalization' ? 'Pending' : 'InProgress';
    case 'ready':
    default:
      return params?.kind === 'plan_finalization' ? 'Pending' : 'InProgress';
  }
};

export const buildInitialMergeWorkflowRuntimeState = (params: {
  taskId: string;
  kind: MergeWorkflowKind;
}): MergeWorkflowRuntimeState => ({
  taskId: params.taskId,
  kind: params.kind,
  phase: 'idle',
  taskStatus: resolveMergeWorkflowTaskStatus('idle', { kind: params.kind }),
  review: null,
  repositories: [],
  blockedRepositories: [],
  message: null,
  lastLoadedAt: null,
});

export const mergeMergeWorkflowRuntimeState = (
  currentState: MergeWorkflowRuntimeState | undefined,
  nextState: Partial<MergeWorkflowRuntimeState> &
    Pick<MergeWorkflowRuntimeState, 'taskId' | 'kind'>
): MergeWorkflowRuntimeState => ({
  ...(currentState || buildInitialMergeWorkflowRuntimeState(nextState)),
  ...nextState,
});

export const toMergeWorkflowRepositoryResult = (
  repository: PlanReviewRepositoryResult
): MergeWorkflowRepositoryResult => ({
  id: repository.id,
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  sourceBranchName: repository.planBranchName,
  targetBranchName: repository.baseBranchName,
  isClean: repository.isClean,
  hasChanges: repository.hasChanges,
  mergeable: repository.mergeable,
  conflictFiles: repository.conflictFiles,
  mergeInProgress: repository.mergeInProgress,
  diff: repository.diff,
  checkStatus: repository.checkStatus,
  blockingKind: repository.blockingKind,
  nextAction: repository.nextAction,
  blockingReason: repository.blockingReason,
});

export const toPlanFinalizationMergeWorkflowRuntimeState = (params: {
  taskId: string;
  review: PlanReviewResult;
  loadedAt?: string;
}): MergeWorkflowRuntimeState => {
  const repositories = params.review.repositories.map(toMergeWorkflowRepositoryResult);
  const blockedRepositories = repositories.filter((repository) =>
    Boolean(repository.blockingReason)
  );
  const phase: MergeWorkflowPhase =
    blockedRepositories.length > 0 ? 'blocked' : 'ready';

  return {
    taskId: params.taskId,
    kind: 'plan_finalization',
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, {
      kind: 'plan_finalization',
    }),
    review: {
      taskId: params.taskId,
      title: params.review.plan.title,
      taskSource: 'plan_finalization',
      planId: params.review.plan.id,
      planTitle: params.review.plan.title,
      targetBranch: params.review.plan.targetBranch,
    },
    repositories,
    blockedRepositories,
    message:
      blockedRepositories.length > 0
        ? 'Resolve the repository blockers before retrying the merge.'
        : null,
    lastLoadedAt: params.loadedAt || new Date().toISOString(),
  };
};

const getMergeWorkflowConflictFiles = (
  status: MergeWorkflowGitStatusLike
): string[] =>
  Array.from(
    new Set([
      ...(status.conflictedFiles || []),
      ...((status.conflicted_files as string[] | undefined) || []),
    ])
  );

const isMergeWorkflowMergeInProgress = (
  status: MergeWorkflowGitStatusLike
): boolean => Boolean(status.mergeInProgress ?? status.merge_in_progress);

const formatMergeWorkflowConflictMessage = (
  repositoryPath: string,
  conflictFiles: string[]
): string => {
  if (conflictFiles.length === 0) {
    return `Cannot continue merge because ${repositoryPath} would conflict during merge.`;
  }
  return `Cannot continue merge because ${repositoryPath} would conflict in: ${conflictFiles.join(', ')}.`;
};

const formatMergeWorkflowMergeInProgressMessage = (
  repositoryPath: string
): string =>
  `Cannot continue merge because ${repositoryPath} already has a merge in progress. Finish or abort it first.`;

const formatMergeWorkflowDirtyRepositoryMessage = (
  repositoryPath: string
): string =>
  `Cannot continue merge because ${repositoryPath} has uncommitted changes.`;

export const buildMergeWorkflowRepositoryBlockingState = (params: {
  repositoryPath: string;
  status: MergeWorkflowGitStatusLike;
  mergeCheck: MergeWorkflowMergeCheckLike;
}): Pick<
  MergeWorkflowRepositoryResult,
  'blockingKind' | 'blockingReason' | 'nextAction' | 'conflictFiles' | 'mergeInProgress'
> => {
  const statusConflictFiles = getMergeWorkflowConflictFiles(params.status);
  const mergeInProgress = isMergeWorkflowMergeInProgress(params.status);

  if (statusConflictFiles.length > 0) {
    return {
      blockingKind: 'merge_conflict',
      blockingReason: formatMergeWorkflowConflictMessage(
        params.repositoryPath,
        statusConflictFiles
      ),
      nextAction: 'resolve_conflicts',
      conflictFiles: statusConflictFiles,
      mergeInProgress,
    };
  }

  if (mergeInProgress) {
    return {
      blockingKind: 'merge_in_progress',
      blockingReason: formatMergeWorkflowMergeInProgressMessage(
        params.repositoryPath
      ),
      nextAction: 'finish_or_abort_merge',
      conflictFiles: [],
      mergeInProgress,
    };
  }

  if (!params.status.is_clean) {
    return {
      blockingKind: 'repository_dirty',
      blockingReason: formatMergeWorkflowDirtyRepositoryMessage(
        params.repositoryPath
      ),
      nextAction: 'clean_repository',
      conflictFiles: [],
      mergeInProgress,
    };
  }

  if (!params.mergeCheck.mergeable) {
    return {
      blockingKind: 'merge_conflict',
      blockingReason: formatMergeWorkflowConflictMessage(
        params.repositoryPath,
        params.mergeCheck.conflictFiles
      ),
      nextAction: 'resolve_conflicts',
      conflictFiles: params.mergeCheck.conflictFiles,
      mergeInProgress,
    };
  }

  return {
    blockingKind: null,
    blockingReason: null,
    nextAction: null,
    conflictFiles: params.mergeCheck.conflictFiles,
    mergeInProgress,
  };
};

export const isMergeWorkflowBlockedErrorLike = (
  error: unknown
): error is MergeWorkflowBlockedErrorLike =>
  error instanceof Error &&
  error.name === 'MergeWorkflowBlockedError' &&
  'taskId' in error &&
  'kind' in error &&
  'repositories' in error &&
  'blockedRepositories' in error;

export const createMergeWorkflowBlockedError = (params: {
  taskId: string;
  kind: MergeWorkflowKind;
  repositories: MergeWorkflowRepositoryResult[];
  message?: string;
}): MergeWorkflowBlockedErrorLike => {
  const blockedRepositories = params.repositories.filter((repository) =>
    Boolean(repository.blockingReason)
  );
  const primaryReason =
    params.message ||
    blockedRepositories[0]?.blockingReason ||
    'Merge workflow is blocked.';
  const message =
    blockedRepositories.length > 1
      ? `${primaryReason} ${blockedRepositories.length} repositories are currently blocked.`
      : primaryReason;

  return Object.assign(new Error(message), {
    name: 'MergeWorkflowBlockedError' as const,
    taskId: params.taskId,
    kind: params.kind,
    repositories: params.repositories,
    blockedRepositories,
  });
};

export const toMergeWorkflowBlockedState = (
  error: unknown,
  fallback?: { taskId: string; kind: MergeWorkflowKind }
): MergeWorkflowBlockedState | null => {
  if (isMergeWorkflowBlockedErrorLike(error)) {
    return {
      taskId: error.taskId,
      kind: error.kind,
      message: error.message,
      repositories: error.repositories,
      blockedRepositories: error.blockedRepositories,
    };
  }

  if (
    error instanceof Error &&
    error.name === 'PlanFinalizationBlockedError' &&
    fallback?.taskId &&
    fallback.kind === 'plan_finalization' &&
    'repositories' in error &&
    'blockedRepositories' in error
  ) {
    const repositories = (error.repositories as PlanReviewRepositoryResult[]).map(
      toMergeWorkflowRepositoryResult
    );
    const blockedRepositories = (
      error.blockedRepositories as PlanReviewRepositoryResult[]
    ).map(toMergeWorkflowRepositoryResult);

    return {
      taskId: fallback.taskId,
      kind: 'plan_finalization',
      message: error.message,
      repositories,
      blockedRepositories,
    };
  }

  return null;
};

export const buildMergeWorkflowFailureState = (
  error: unknown,
  fallback?: { taskId: string; kind: MergeWorkflowKind }
): {
  lastError: string;
  runtimePatch: Partial<MergeWorkflowRuntimeState>;
} => {
  const blocked = toMergeWorkflowBlockedState(error, fallback);

  return {
    lastError: toServiceError(error).message,
    runtimePatch: blocked
      ? {
          phase: 'blocked',
          taskStatus: resolveMergeWorkflowTaskStatus('blocked', {
            kind: blocked.kind,
          }),
          repositories: blocked.repositories,
          blockedRepositories: blocked.blockedRepositories,
          message: blocked.message,
          lastLoadedAt: new Date().toISOString(),
        }
      : {
          phase: 'failed',
          taskStatus: resolveMergeWorkflowTaskStatus('failed', {
            kind: fallback?.kind,
          }),
          message: toServiceError(error).message,
        },
  };
};

export const resolveMergeWorkflowViewState = (
  runtime: MergeWorkflowRuntimeState | null | undefined,
  options?: { canArchive?: boolean }
): MergeWorkflowViewState => {
  const phase = runtime?.phase ?? 'loading';
  const isLoading = phase === 'loading' || phase === 'idle' || phase === 'loading_review';
  const isMerging = phase === 'merging';
  const isArchiving = phase === 'archiving';
  const isBusy = isMerging || isArchiving;
  const isBlocked =
    phase === 'blocked' || Boolean(runtime?.blockedRepositories.length);
  const isFailed = phase === 'failed';
  const canArchive = (options?.canArchive ?? false) && !isLoading && !isBusy;

  return {
    phase,
    isLoading,
    isBlocked,
    isFailed,
    isMerging,
    isArchiving,
    isBusy,
    canMerge: !isLoading && !isBusy && !isBlocked,
    canRetry: !isLoading && !isBusy && (isBlocked || isFailed),
    canResolveAutomatically: !isLoading && !isBusy && isBlocked,
    canArchive,
  };
};

export const resolveMergeWorkflowIndicatorState = (
  runtime: MergeWorkflowRuntimeState | null | undefined
): MergeWorkflowIndicatorState | null => {
  switch (runtime?.phase) {
    case 'merging':
      return 'merging';
    case 'blocked':
      return 'merge_blocked';
    case 'failed':
      return 'merge_failed';
    default:
      return null;
  }
};

export const selectMergeWorkflowFocusTarget = <
  Target extends MergeWorkflowFocusableTargetLike,
>(
  targets: Target[],
  preferredProjectId?: string | null
): Target | null => {
  if (targets.length === 0) {
    return null;
  }

  if (preferredProjectId) {
    const matchingTarget = targets.find(
      (target) => target.projectId === preferredProjectId
    );
    if (matchingTarget) {
      return matchingTarget;
    }
  }

  return targets[0] || null;
};

export const resolveMergeWorkflowFocusContext = <
  Target extends MergeWorkflowFocusableTargetLike,
>(
  targets: Target[],
  preferredProjectId?: string | null
): { repoPath: string | null; branchName: string | null; target: Target | null } => {
  const target = selectMergeWorkflowFocusTarget(targets, preferredProjectId);
  return {
    repoPath: target?.repoPath || null,
    branchName:
      target?.targetBranchName ||
      target?.branchName ||
      target?.sourceBranchName ||
      null,
    target,
  };
};
