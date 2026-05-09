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
  | 'partial'
  | 'blocked'
  | 'merging'
  | 'archiving'
  | 'failed';

export type MergeWorkflowBlockingKind = PlanFinalizationBlockingKind;
export type MergeWorkflowNextAction = PlanFinalizationNextAction;
export type MergeWorkflowStrategy =
  | 'dirty'
  | 'fast_forward_available'
  | 'rebase_available'
  | 'merge_commit_available'
  | 'file_conflict'
  | 'merge_in_progress'
  | 'merge_ready_to_complete'
  | 'no_source_changes';

export type MergeWorkflowResolutionAction =
  | 'stash_dirty'
  | 'commit_staged_resolution'
  | 'revert_dirty'
  | 'abort_merge'
  | 'assistant'
  | 'fast_forward'
  | 'rebase_then_continue'
  | 'merge_commit'
  | 'complete_merge'
  | 'retry_check';

export interface MergeWorkflowDirtyFile {
  path: string;
  status: string;
  area: 'staged' | 'unstaged' | 'untracked';
}

export interface MergeWorkflowRepositoryResult {
  id: string;
  projectId: string;
  repoPath: string;
  repositoryRootPath: string;
  integrationWorktreePath: string | null;
  sourceBranchName: string;
  targetBranchName: string;
  progressState: 'pending' | 'merged' | 'blocked' | 'no_changes';
  hadChangesAtStart: boolean;
  mergeAppliedAt: string | null;
  isClean: boolean;
  hasChanges: boolean;
  ahead: number;
  behind: number;
  mergeable: boolean;
  conflictFiles: string[];
  dirtyFiles: MergeWorkflowDirtyFile[];
  mergeInProgress: boolean;
  diff: string;
  checkStatus: 'not_run' | 'passed' | 'failed';
  blockingKind: MergeWorkflowBlockingKind | null;
  nextAction: MergeWorkflowNextAction | null;
  blockingReason: string | null;
  isSourcePublished: boolean;
  mergeStrategy: MergeWorkflowStrategy;
  recommendedAction: MergeWorkflowResolutionAction | null;
  availableActions: MergeWorkflowResolutionAction[];
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
  isPartial: boolean;
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
  | 'merge_partial'
  | 'merge_blocked'
  | 'merge_failed';

export interface MergeWorkflowIndicatorSource {
  phase?: MergeWorkflowPhase | null;
}

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
  staged_files?: Array<{ path: string; status?: string | null }>;
  stagedFiles?: Array<{ path: string; status?: string | null }>;
  unstaged_files?: Array<{ path: string; status?: string | null }>;
  unstagedFiles?: Array<{ path: string; status?: string | null }>;
  untracked_files?: Array<{ path: string; status?: string | null }>;
  untrackedFiles?: Array<{ path: string; status?: string | null }>;
  conflicted_files?: string[];
  conflictedFiles?: string[];
  merge_in_progress?: boolean;
  mergeInProgress?: boolean;
}

interface MergeWorkflowMergeCheckLike {
  mergeable: boolean;
  conflictFiles: string[];
  hasChanges?: boolean;
  ahead?: number;
  behind?: number;
}

interface MergeWorkflowRebaseCheckLike {
  rebaseable: boolean;
  conflictFiles?: string[];
}

interface MergeWorkflowBranchListLike {
  remote?: Array<{ name: string }>;
}

export type MergeWorkflowMergeExecutionAction = Extract<
  MergeWorkflowResolutionAction,
  'fast_forward' | 'rebase_then_continue' | 'merge_commit' | 'complete_merge'
>;

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
    case 'partial':
      return 'Blocked';
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

const mapDirtyStatusFiles = (
  files: Array<{ path: string; status?: string | null }> | undefined,
  area: MergeWorkflowDirtyFile['area']
): MergeWorkflowDirtyFile[] =>
  (files || [])
    .filter((file) => file.path.trim().length > 0)
    .map((file) => ({
      path: file.path,
      status: file.status || (area === 'untracked' ? 'untracked' : 'modified'),
      area,
    }));

export const collectMergeWorkflowDirtyFiles = (
  status: MergeWorkflowGitStatusLike
): MergeWorkflowDirtyFile[] => [
  ...mapDirtyStatusFiles(status.stagedFiles || status.staged_files, 'staged'),
  ...mapDirtyStatusFiles(status.unstagedFiles || status.unstaged_files, 'unstaged'),
  ...mapDirtyStatusFiles(status.untrackedFiles || status.untracked_files, 'untracked'),
];

export const isMergeWorkflowStagedResolutionRepository = (
  repository: Pick<
    MergeWorkflowRepositoryResult,
    'blockingKind' | 'nextAction' | 'mergeInProgress' | 'conflictFiles'
  > & {
    dirtyFiles?: MergeWorkflowDirtyFile[];
  }
): boolean => {
  const dirtyFiles = repository.dirtyFiles ?? [];
  return (
    repository.blockingKind === 'repository_dirty' &&
    repository.nextAction === 'clean_repository' &&
    !repository.mergeInProgress &&
    repository.conflictFiles.length === 0 &&
    dirtyFiles.length > 0 &&
    dirtyFiles.every((file) => file.area === 'staged')
  );
};

export const isMergeWorkflowSourcePublished = (
  branches: MergeWorkflowBranchListLike | null | undefined,
  sourceBranchName: string
): boolean =>
  Boolean(
    branches?.remote?.some(
      (branch) =>
        branch.name === `origin/${sourceBranchName}` ||
        branch.name.endsWith(`/${sourceBranchName}`)
    )
  );

export const shouldCheckMergeWorkflowRebase = (params: {
  status: { is_clean: boolean };
  mergeCheck: { mergeable: boolean; ahead?: number; behind?: number };
  isSourcePublished: boolean;
}): boolean =>
  params.status.is_clean &&
  params.mergeCheck.mergeable &&
  (params.mergeCheck.ahead ?? 0) > 0 &&
  (params.mergeCheck.behind ?? 0) > 0 &&
  !params.isSourcePublished;

export const resolveMergeWorkflowStrategy = (params: {
  status: MergeWorkflowGitStatusLike;
  mergeCheck: MergeWorkflowMergeCheckLike;
  isSourcePublished?: boolean;
  rebaseCheck?: MergeWorkflowRebaseCheckLike | null;
}): {
  mergeStrategy: MergeWorkflowStrategy;
  recommendedAction: MergeWorkflowResolutionAction | null;
  availableActions: MergeWorkflowResolutionAction[];
  dirtyFiles: MergeWorkflowDirtyFile[];
  ahead: number;
  behind: number;
} => {
  const conflictFiles = getMergeWorkflowConflictFiles(params.status);
  const mergeInProgress = isMergeWorkflowMergeInProgress(params.status);
  const dirtyFiles = collectMergeWorkflowDirtyFiles(params.status);
  const ahead = params.mergeCheck.ahead ?? (params.mergeCheck.hasChanges === false ? 0 : 1);
  const behind = params.mergeCheck.behind ?? 0;

  if (conflictFiles.length > 0) {
    return {
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (mergeInProgress) {
    return {
      mergeStrategy: 'merge_ready_to_complete',
      recommendedAction: 'complete_merge',
      availableActions: ['complete_merge', 'abort_merge', 'retry_check'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (!params.status.is_clean) {
    if (
      dirtyFiles.length > 0 &&
      dirtyFiles.every((file) => file.area === 'staged')
    ) {
      return {
        mergeStrategy: 'dirty',
        recommendedAction: 'commit_staged_resolution',
        availableActions: [
          'commit_staged_resolution',
          'revert_dirty',
          'assistant',
          'retry_check',
        ],
        dirtyFiles,
        ahead,
        behind,
      };
    }

    return {
      mergeStrategy: 'dirty',
      recommendedAction: 'stash_dirty',
      availableActions: ['stash_dirty', 'revert_dirty', 'assistant', 'retry_check'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (!params.mergeCheck.mergeable) {
    return {
      mergeStrategy: 'file_conflict',
      recommendedAction: 'assistant',
      availableActions: ['assistant', 'retry_check'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (params.mergeCheck.hasChanges === false || ahead === 0) {
    return {
      mergeStrategy: 'no_source_changes',
      recommendedAction: null,
      availableActions: ['retry_check'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (behind === 0) {
    return {
      mergeStrategy: 'fast_forward_available',
      recommendedAction: 'fast_forward',
      availableActions: ['fast_forward', 'merge_commit'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  if (!params.isSourcePublished && params.rebaseCheck?.rebaseable) {
    return {
      mergeStrategy: 'rebase_available',
      recommendedAction: 'rebase_then_continue',
      availableActions: ['rebase_then_continue', 'merge_commit', 'assistant'],
      dirtyFiles,
      ahead,
      behind,
    };
  }

  return {
    mergeStrategy: 'merge_commit_available',
    recommendedAction: 'merge_commit',
    availableActions: ['merge_commit'],
    dirtyFiles,
    ahead,
    behind,
  };
};

const isRepositoryMergeReadyToComplete = (
  repository: Pick<
    PlanReviewRepositoryResult,
    'mergeInProgress' | 'conflictFiles' | 'blockingKind'
  >
): boolean =>
  repository.mergeInProgress &&
  repository.conflictFiles.length === 0 &&
  repository.blockingKind !== 'repository_dirty';

const inferRepositoryMergeStrategy = (
  repository: PlanReviewRepositoryResult
): MergeWorkflowStrategy => {
  if (isRepositoryMergeReadyToComplete(repository)) {
    return 'merge_ready_to_complete';
  }
  if (repository.mergeStrategy) {
    return repository.mergeStrategy;
  }
  if (repository.blockingKind === 'repository_dirty') {
    return 'dirty';
  }
  if (repository.blockingKind === 'merge_in_progress') {
    return 'merge_in_progress';
  }
  if (repository.blockingKind === 'merge_conflict') {
    return 'file_conflict';
  }
  return repository.hasChanges ? 'merge_commit_available' : 'no_source_changes';
};

const inferRepositoryRecommendedAction = (
  repository: PlanReviewRepositoryResult
): MergeWorkflowResolutionAction | null => {
  if (isRepositoryMergeReadyToComplete(repository)) {
    return 'complete_merge';
  }
  if (repository.recommendedAction !== undefined) {
    return repository.recommendedAction;
  }
  if (repository.blockingKind === 'repository_dirty') {
    return isMergeWorkflowStagedResolutionRepository(repository)
      ? 'commit_staged_resolution'
      : 'stash_dirty';
  }
  if (repository.blockingKind === 'merge_in_progress') {
    return 'abort_merge';
  }
  if (repository.blockingKind === 'merge_conflict') {
    return 'assistant';
  }
  return repository.hasChanges ? 'merge_commit' : null;
};

const inferRepositoryAvailableActions = (
  repository: PlanReviewRepositoryResult
): MergeWorkflowResolutionAction[] => {
  if (isRepositoryMergeReadyToComplete(repository)) {
    return ['complete_merge', 'abort_merge', 'retry_check'];
  }
  if (repository.availableActions) {
    return repository.availableActions;
  }
  if (repository.blockingKind === 'repository_dirty') {
    return isMergeWorkflowStagedResolutionRepository(repository)
      ? ['commit_staged_resolution', 'revert_dirty', 'assistant', 'retry_check']
      : ['stash_dirty', 'revert_dirty', 'assistant', 'retry_check'];
  }
  if (repository.blockingKind === 'merge_in_progress') {
    return ['abort_merge', 'assistant', 'retry_check'];
  }
  if (repository.blockingKind === 'merge_conflict') {
    return ['assistant', 'retry_check'];
  }
  return repository.hasChanges ? ['merge_commit'] : ['retry_check'];
};

export const toMergeWorkflowRepositoryResult = (
  repository: PlanReviewRepositoryResult
): MergeWorkflowRepositoryResult => ({
  id: repository.id,
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  repositoryRootPath: repository.repoPath,
  integrationWorktreePath: null,
  sourceBranchName: repository.planBranchName,
  targetBranchName: repository.baseBranchName,
  progressState: repository.hasChanges ? 'pending' : 'no_changes',
  hadChangesAtStart: repository.hasChanges,
  mergeAppliedAt: null,
  isClean: repository.isClean,
  hasChanges: repository.hasChanges,
  ahead: repository.ahead ?? (repository.hasChanges ? 1 : 0),
  behind: repository.behind ?? 0,
  mergeable: repository.mergeable,
  conflictFiles: repository.conflictFiles,
  dirtyFiles: repository.dirtyFiles ?? [],
  mergeInProgress: repository.mergeInProgress,
  diff: repository.diff,
  checkStatus: repository.checkStatus,
  blockingKind: repository.blockingKind,
  nextAction: repository.nextAction,
  blockingReason: repository.blockingReason,
  isSourcePublished: repository.isSourcePublished ?? false,
  mergeStrategy: inferRepositoryMergeStrategy(repository),
  recommendedAction: inferRepositoryRecommendedAction(repository),
  availableActions: inferRepositoryAvailableActions(repository),
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

export const resolveMergeWorkflowPhaseFromRepositories = (
  repositories: Array<
    Pick<MergeWorkflowRepositoryResult, 'progressState' | 'blockingReason'>
  >
): MergeWorkflowPhase => {
  const mergedCount = repositories.filter(
    (repository) => repository.progressState === 'merged'
  ).length;
  const blockedCount = repositories.filter(
    (repository) =>
      repository.progressState === 'blocked' || Boolean(repository.blockingReason)
  ).length;

  if (blockedCount > 0) {
    return mergedCount > 0 ? 'partial' : 'blocked';
  }

  return 'ready';
};

export const toPendingMergeWorkflowRepositoryResult = (params: {
  id: string;
  projectId: string;
  repoPath: string;
  sourceBranchName: string;
  targetBranchName: string;
  hasChanges?: boolean;
}): MergeWorkflowRepositoryResult => ({
  id: params.id,
  projectId: params.projectId,
  repoPath: params.repoPath,
  repositoryRootPath: params.repoPath,
  integrationWorktreePath: null,
  sourceBranchName: params.sourceBranchName,
  targetBranchName: params.targetBranchName,
  progressState: params.hasChanges === false ? 'no_changes' : 'pending',
  hadChangesAtStart: params.hasChanges !== false,
  mergeAppliedAt: null,
  isClean: true,
  hasChanges: params.hasChanges !== false,
  ahead: params.hasChanges === false ? 0 : 1,
  behind: 0,
  mergeable: true,
  conflictFiles: [],
  dirtyFiles: [],
  mergeInProgress: false,
  diff: '',
  checkStatus: 'not_run',
  blockingKind: null,
  nextAction: null,
  blockingReason: null,
  isSourcePublished: false,
  mergeStrategy: params.hasChanges === false
    ? 'no_source_changes'
    : 'merge_commit_available',
  recommendedAction: params.hasChanges === false ? null : 'merge_commit',
  availableActions: params.hasChanges === false ? ['retry_check'] : ['merge_commit'],
});

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
      blockingKind: null,
      blockingReason: null,
      nextAction: 'complete_merge',
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

export const isMergeWorkflowRepositoryActionableByModal = (
  repository: Pick<
    MergeWorkflowRepositoryResult,
    'recommendedAction' | 'mergeStrategy' | 'progressState'
  >
): boolean =>
  repository.progressState === 'pending' &&
  (repository.recommendedAction === 'fast_forward' ||
    repository.recommendedAction === 'rebase_then_continue');

export const isMergeWorkflowFileConflictRepository = (
  repository: Pick<
    MergeWorkflowRepositoryResult,
    'mergeStrategy' | 'blockingKind' | 'conflictFiles'
  >
): boolean =>
  repository.mergeStrategy !== 'dirty' &&
  repository.blockingKind !== 'repository_dirty' &&
  (
    repository.mergeStrategy === 'file_conflict' ||
    repository.blockingKind === 'merge_conflict' ||
    repository.conflictFiles.length > 0
  );

export const mergeWorkflowNeedsUserDecision = (
  runtime: Pick<MergeWorkflowRuntimeState, 'repositories' | 'blockedRepositories'> | null | undefined
): boolean =>
  Boolean(
    runtime &&
      (runtime.blockedRepositories.length > 0 ||
        runtime.repositories.some(isMergeWorkflowRepositoryActionableByModal))
  );

export const resolveMergeWorkflowViewState = (
  runtime: MergeWorkflowRuntimeState | null | undefined,
  options?: { canArchive?: boolean }
): MergeWorkflowViewState => {
  const phase = runtime?.phase ?? 'loading';
  const isLoading = phase === 'loading' || phase === 'idle' || phase === 'loading_review';
  const isMerging = phase === 'merging';
  const isArchiving = phase === 'archiving';
  const isBusy = isMerging || isArchiving;
  const isPartial = phase === 'partial';
  const isBlocked =
    phase === 'blocked' || isPartial || Boolean(runtime?.blockedRepositories.length);
  const isFailed = phase === 'failed';
  const canArchive = (options?.canArchive ?? false) && !isLoading && !isBusy;

  return {
    phase,
    isLoading,
    isPartial,
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
  runtime: MergeWorkflowIndicatorSource | null | undefined
): MergeWorkflowIndicatorState | null => {
  switch (runtime?.phase) {
    case 'merging':
      return 'merging';
    case 'partial':
      return 'merge_partial';
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
