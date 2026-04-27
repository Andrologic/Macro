import type { TaskStatus } from '../types';
import {
  resolveMergeWorkflowPhaseFromRepositories,
  resolveMergeWorkflowTaskStatus,
  type MergeWorkflowBlockingKind,
  type MergeWorkflowKind,
  type MergeWorkflowPhase,
  type MergeWorkflowRepositoryResult,
  type MergeWorkflowRuntimeState,
} from './mergeWorkflow';

export interface PersistedMergeWorkflowRepositoryState {
  id: string;
  projectId: string;
  repoPath: string;
  sourceBranchName: string;
  targetBranchName: string;
  state: 'pending' | 'merged' | 'blocked' | 'no_changes';
  hadChangesAtStart: boolean;
  mergeAppliedAt: string | null;
  blockingKind: MergeWorkflowBlockingKind | null;
  blockingReason: string | null;
  conflictFiles: string[];
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
  sourceBranchName: repository.sourceBranchName,
  targetBranchName: repository.targetBranchName,
  state: repository.progressState,
  hadChangesAtStart: repository.hadChangesAtStart,
  mergeAppliedAt: repository.mergeAppliedAt,
  blockingKind: repository.blockingKind,
  blockingReason: repository.blockingReason,
  conflictFiles: [...repository.conflictFiles],
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
): MergeWorkflowRepositoryResult => ({
  id: repository.id,
  projectId: repository.projectId,
  repoPath: repository.repoPath,
  sourceBranchName: repository.sourceBranchName,
  targetBranchName: repository.targetBranchName,
  progressState: repository.state,
  hadChangesAtStart: repository.hadChangesAtStart,
  mergeAppliedAt: repository.mergeAppliedAt,
  isClean: repository.state !== 'blocked',
  hasChanges: repository.hadChangesAtStart,
  mergeable: repository.state !== 'blocked',
  conflictFiles: [...repository.conflictFiles],
  mergeInProgress: repository.blockingKind === 'merge_in_progress',
  diff: '',
  checkStatus:
    repository.state === 'merged'
      ? 'passed'
      : repository.state === 'blocked'
        ? 'failed'
        : 'not_run',
  blockingKind: repository.blockingKind,
  nextAction:
    repository.blockingKind === 'repository_dirty'
      ? 'clean_repository'
      : repository.blockingKind === 'merge_conflict'
        ? 'resolve_conflicts'
        : repository.blockingKind === 'merge_in_progress'
          ? 'finish_or_abort_merge'
          : null,
  blockingReason: repository.blockingReason,
});

export const buildMergeWorkflowRuntimeFromPersistedSession = (params: {
  taskId: string;
  session: PersistedMergeWorkflowSession;
}): MergeWorkflowRuntimeState => {
  const repositories = params.session.repositories.map(toRuntimeRepository);
  const blockedRepositories = repositories.filter(
    (repository) =>
      repository.progressState === 'blocked' || Boolean(repository.blockingReason),
  );

  return {
    taskId: params.taskId,
    kind: params.session.kind,
    phase: params.session.phase,
    taskStatus: params.session.taskStatus,
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
      sourceBranchName: repository.sourceBranchName,
      targetBranchName: repository.targetBranchName,
      state: repository.progressState,
      hadChangesAtStart: repository.hadChangesAtStart,
      mergeAppliedAt: repository.mergeAppliedAt,
      blockingKind: repository.blockingKind,
      blockingReason: repository.blockingReason,
      conflictFiles: repository.conflictFiles,
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
