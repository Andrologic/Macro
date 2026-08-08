import type { TaskStatus } from '../types';
import {
  resolveMergeWorkflowPhaseFromRepositories,
  resolveMergeWorkflowTaskStatus,
  type MergeWorkflowBlockingKind,
  type MergeWorkflowDirtyFile,
  type MergeWorkflowKind,
  type MergeWorkflowPhase,
  type MergeWorkflowResolutionAction,
  type MergeWorkflowRepositoryResult,
  type MergeWorkflowRuntimeState,
  type MergeWorkflowStrategy,
} from './mergeWorkflow';

export interface PersistedMergeWorkflowRepositoryState {
  id: string;
  projectId: string;
  repoPath: string;
  repositoryRootPath: string;
  integrationWorktreePath: string | null;
  sourceBranchName: string;
  targetBranchName: string;
  state: 'pending' | 'merged' | 'blocked' | 'no_changes';
  hadChangesAtStart: boolean;
  mergeAppliedAt: string | null;
  blockingKind: MergeWorkflowBlockingKind | null;
  blockingReason: string | null;
  conflictFiles: string[];
  dirtyFiles?: MergeWorkflowDirtyFile[];
  mergeInProgress?: boolean;
  ahead?: number;
  behind?: number;
  isSourcePublished?: boolean;
  mergeStrategy?: MergeWorkflowStrategy;
  recommendedAction?: MergeWorkflowResolutionAction | null;
  availableActions?: MergeWorkflowResolutionAction[];
}

export interface PersistedMergeWorkflowSession {
  kind: MergeWorkflowKind;
  phase: MergeWorkflowPhase;
  taskStatus: TaskStatus;
  startedAt: string;
  updatedAt: string;
  lastLoadedAt: string | null;
  message: string | null;
  repositories: PersistedMergeWorkflowRepositoryState[];
}

export interface MergeWorkflowSummary {
  kind: MergeWorkflowKind;
  phase: MergeWorkflowPhase;
  taskStatus: TaskStatus;
  repositoryCount: number;
  mergedRepositoryCount: number;
  blockedRepositoryCount: number;
  unresolvedRepositoryCount: number;
  updatedAt: string | null;
  message: string | null;
}

const toPersistedRepositoryState = (
  repository: MergeWorkflowRepositoryResult,
): PersistedMergeWorkflowRepositoryState => ({
  id: repository.id,
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  repositoryRootPath: repository.repositoryRootPath,
  integrationWorktreePath: repository.integrationWorktreePath ?? null,
  sourceBranchName: repository.sourceBranchName,
  targetBranchName: repository.targetBranchName,
  state: repository.progressState,
  hadChangesAtStart: repository.hadChangesAtStart,
  mergeAppliedAt: repository.mergeAppliedAt,
  blockingKind: repository.blockingKind,
  blockingReason: repository.blockingReason,
  conflictFiles: [...repository.conflictFiles],
  dirtyFiles: [...repository.dirtyFiles],
  mergeInProgress: repository.mergeInProgress,
  ahead: repository.ahead,
  behind: repository.behind,
  isSourcePublished: repository.isSourcePublished,
  mergeStrategy: repository.mergeStrategy,
  recommendedAction: repository.recommendedAction,
  availableActions: [...repository.availableActions],
});

export const toPersistedMergeWorkflowSession = (params: {
  runtime: Pick<
    MergeWorkflowRuntimeState,
    | 'kind'
    | 'phase'
    | 'taskStatus'
    | 'lastLoadedAt'
    | 'message'
    | 'repositories'
  >;
  previous?: PersistedMergeWorkflowSession | null;
  updatedAt?: string;
}): PersistedMergeWorkflowSession => {
  const updatedAt = params.updatedAt || new Date().toISOString();
  return {
    kind: params.runtime.kind,
    phase: params.runtime.phase,
    taskStatus: params.runtime.taskStatus,
    startedAt: params.previous?.startedAt || updatedAt,
    updatedAt,
    lastLoadedAt: params.runtime.lastLoadedAt || params.previous?.lastLoadedAt || updatedAt,
    message: params.runtime.message || null,
    repositories: params.runtime.repositories.map(toPersistedRepositoryState),
  };
};

const toRuntimeRepository = (
  repository: PersistedMergeWorkflowRepositoryState,
): MergeWorkflowRepositoryResult => {
  const repositoryRootPath = repository.repositoryRootPath || repository.repoPath;
  const conflictFiles = [...repository.conflictFiles];
  const dirtyFiles = [...(repository.dirtyFiles || [])];
  const isDirty = repository.blockingKind === 'repository_dirty';
  const hasFileConflicts =
    conflictFiles.length > 0 || repository.blockingKind === 'merge_conflict';
  const mergeInProgress = Boolean(
    repository.mergeInProgress ||
    repository.mergeStrategy === 'merge_ready_to_complete' ||
    repository.recommendedAction === 'complete_merge' ||
    (
      repository.blockingKind === 'merge_in_progress' &&
      !isDirty &&
      !hasFileConflicts
    )
  );
  const isReadyToComplete =
    mergeInProgress &&
    !isDirty &&
    !hasFileConflicts;
  const progressState = isReadyToComplete && repository.state === 'blocked'
    ? 'pending'
    : repository.state;
  const blockingKind = isReadyToComplete ? null : repository.blockingKind;
  const blockingReason = isReadyToComplete ? null : repository.blockingReason;

  return {
    id: repository.id,
    projectId: repository.projectId,
    repoPath: repository.repoPath,
    repositoryRootPath,
    integrationWorktreePath: repository.integrationWorktreePath ?? null,
    sourceBranchName: repository.sourceBranchName,
    targetBranchName: repository.targetBranchName,
    progressState,
    hadChangesAtStart: repository.hadChangesAtStart,
    mergeAppliedAt: repository.mergeAppliedAt,
    isClean: progressState !== 'blocked' || isReadyToComplete,
    hasChanges: repository.hadChangesAtStart,
    ahead: repository.ahead ?? (repository.hadChangesAtStart ? 1 : 0),
    behind: repository.behind ?? 0,
    mergeable: progressState !== 'blocked' || isReadyToComplete,
    conflictFiles,
    dirtyFiles,
    mergeInProgress,
    diff: '',
    checkStatus:
      repository.state === 'merged'
        ? 'passed'
        : progressState === 'blocked'
          ? 'failed'
          : 'not_run',
    blockingKind,
    nextAction: isReadyToComplete
      ? 'complete_merge'
      : blockingKind === 'repository_dirty'
        ? 'clean_repository'
        : blockingKind === 'merge_conflict'
          ? 'resolve_conflicts'
          : blockingKind === 'merge_in_progress'
            ? 'finish_or_abort_merge'
            : null,
    blockingReason,
    isSourcePublished: repository.isSourcePublished ?? false,
    mergeStrategy: isReadyToComplete
      ? 'merge_ready_to_complete'
      : repository.mergeStrategy ??
        (progressState === 'blocked'
          ? 'dirty'
          : repository.hadChangesAtStart
            ? 'merge_commit_available'
            : 'no_source_changes'),
    recommendedAction: isReadyToComplete
      ? 'complete_merge'
      : repository.recommendedAction ??
        (progressState === 'blocked'
          ? 'assistant'
          : repository.hadChangesAtStart
            ? 'merge_commit'
            : null),
    availableActions: isReadyToComplete
      ? ['complete_merge', 'abort_merge', 'retry_check']
      : repository.availableActions ??
        (progressState === 'blocked'
          ? ['assistant', 'retry_check']
          : repository.hadChangesAtStart
            ? ['merge_commit']
            : ['retry_check']),
  };
};

export const buildMergeWorkflowRuntimeFromPersistedSession = (params: {
  taskId: string;
  session: PersistedMergeWorkflowSession;
}): MergeWorkflowRuntimeState => {
  const repositories = params.session.repositories.map(toRuntimeRepository);
  const blockedRepositories = repositories.filter(
    (repository) =>
      repository.progressState === 'blocked' || Boolean(repository.blockingReason),
  );
  const phase = resolveMergeWorkflowPhaseFromRepositories(repositories);

  return {
    taskId: params.taskId,
    kind: params.session.kind,
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, { kind: params.session.kind }),
    review: null,
    repositories,
    blockedRepositories,
    message: params.session.message,
    lastLoadedAt: params.session.lastLoadedAt,
  };
};

export const summarizePersistedMergeWorkflowSession = (
  session: PersistedMergeWorkflowSession | null | undefined,
): MergeWorkflowSummary | null => {
  if (!session) {
    return null;
  }

  const mergedRepositoryCount = session.repositories.filter(
    (repository) => repository.state === 'merged',
  ).length;
  const blockedRepositoryCount = session.repositories.filter(
    (repository) => repository.state === 'blocked',
  ).length;
  const unresolvedRepositoryCount = session.repositories.filter(
    (repository) =>
      repository.state === 'pending' || repository.state === 'blocked',
  ).length;

  return {
    kind: session.kind,
    phase: session.phase,
    taskStatus: session.taskStatus,
    repositoryCount: session.repositories.length,
    mergedRepositoryCount,
    blockedRepositoryCount,
    unresolvedRepositoryCount,
    updatedAt: session.updatedAt,
    message: session.message,
  };
};

export const resolvePersistedMergeWorkflowPhase = (
  repositories: PersistedMergeWorkflowRepositoryState[],
): MergeWorkflowPhase =>
  resolveMergeWorkflowPhaseFromRepositories(
    repositories.map((repository) => ({
      progressState: repository.state,
      blockingReason: repository.blockingReason,
    })),
  );

export const overlayPersistedMergeWorkflowSession = (params: {
  runtime: MergeWorkflowRuntimeState;
  session: PersistedMergeWorkflowSession | null | undefined;
}): MergeWorkflowRuntimeState => {
  const session = params.session;
  if (!session) {
    return params.runtime;
  }

  const persistedById = new Map(
    session.repositories.map((repository) => [repository.id, repository]),
  );
  const repositories = params.runtime.repositories.map((repository): MergeWorkflowRepositoryResult => {
    const persisted = persistedById.get(repository.id);
    if (!persisted) {
      return repository;
    }

    const isMerged = persisted.state === 'merged';
    const isNoChanges = persisted.state === 'no_changes';

    if (!isMerged && !isNoChanges) {
      return {
        ...repository,
        hadChangesAtStart:
          repository.hadChangesAtStart || persisted.hadChangesAtStart,
        mergeAppliedAt: persisted.mergeAppliedAt,
      };
    }

    return {
      ...repository,
      progressState: persisted.state,
      hadChangesAtStart: persisted.hadChangesAtStart,
      mergeAppliedAt: persisted.mergeAppliedAt,
      hasChanges: isNoChanges
        ? false
        : repository.hasChanges || persisted.hadChangesAtStart,
      isClean: true,
      mergeable: true,
      blockingKind: null,
      blockingReason: null,
      conflictFiles: [],
      dirtyFiles: [],
      ahead: repository.ahead,
      behind: repository.behind,
      isSourcePublished: repository.isSourcePublished,
      mergeStrategy: repository.mergeStrategy,
      recommendedAction: repository.recommendedAction,
      availableActions: repository.availableActions,
      checkStatus: 'passed',
    };
  });
  const blockedRepositories = repositories.filter(
    (repository) =>
      repository.progressState === 'blocked' || Boolean(repository.blockingReason),
  );
  const phase = resolvePersistedMergeWorkflowPhase(
    repositories.map((repository) => ({
      id: repository.id,
      projectId: repository.projectId,
      repoPath: repository.repoPath,
      repositoryRootPath: repository.repositoryRootPath,
      integrationWorktreePath: repository.integrationWorktreePath ?? null,
      sourceBranchName: repository.sourceBranchName,
      targetBranchName: repository.targetBranchName,
      state: repository.progressState,
      hadChangesAtStart: repository.hadChangesAtStart,
      mergeAppliedAt: repository.mergeAppliedAt,
      blockingKind: repository.blockingKind,
      blockingReason: repository.blockingReason,
      conflictFiles: repository.conflictFiles,
      dirtyFiles: repository.dirtyFiles,
      ahead: repository.ahead,
      behind: repository.behind,
      isSourcePublished: repository.isSourcePublished,
      mergeStrategy: repository.mergeStrategy,
      recommendedAction: repository.recommendedAction,
      availableActions: repository.availableActions,
      mergeInProgress: repository.mergeInProgress,
    })),
  );

  return {
    ...params.runtime,
    phase,
    taskStatus: resolveMergeWorkflowTaskStatus(phase, { kind: params.runtime.kind }),
    repositories,
    blockedRepositories,
    message:
      session.message ||
      (phase === 'partial'
        ? 'Some repositories were already merged. Resolve the remaining blockers, then retry.'
        : params.runtime.message),
  };
};
